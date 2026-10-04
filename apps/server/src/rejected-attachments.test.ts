import { describe, expect, test } from "bun:test";

import { OmniRushGatewayBroker } from "./omnirush-gateway-broker.js";
import { RejectedAttachments, attachmentsIn, isRejectedAttachmentError, replaceAttachments } from "./rejected-attachments.js";

// The 400 a tester got after the read tool returned an invalid PDF (every later turn failed with it).
const CORRUPT = "The file you uploaded is badly formatted or corrupted. Please fix the file and try again.";
const BAD_PDF = "data:application/pdf;base64,JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyA+PgplbmRvYmoKdHJhaWxlcgo8PCAvUm9vdCAxIDAgUiA+PgolJUVPRgo=";
const IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function responsesBody(prompt: string, withPdf = true) {
  return {
    model: "gpt-6-sol",
    stream: true,
    input: [
      { role: "user", content: [{ type: "input_text", text: "Open bad.pdf with your file read tool" }] },
      { type: "function_call", call_id: "call_1", name: "read", arguments: "{\"filePath\":\"bad.pdf\"}" },
      { type: "function_call_output", call_id: "call_1", output: "PDF read successfully" },
      ...(withPdf ? [{ role: "user", content: [{ type: "input_file", filename: "bad.pdf", file_data: BAD_PDF }, { type: "input_image", image_url: IMAGE }] }] : []),
      { role: "user", content: [{ type: "input_text", text: prompt }] },
    ],
  };
}

describe("rejected attachments", () => {
  test("a 400 about a file or image is recognised; other errors are not", () => {
    expect(isRejectedAttachmentError(400, CORRUPT)).toBe(true);
    expect(isRejectedAttachmentError(400, "Invalid image data")).toBe(true);
    expect(isRejectedAttachmentError(400, "Unsupported parameter: 'max_output_tokens'")).toBe(false);
    expect(isRejectedAttachmentError(500, CORRUPT)).toBe(false);
  });

  test("a new PDF and a new image refused for \"the file\": only the PDF is suspected", () => {
    const both = attachmentsIn(responsesBody("x"));
    expect(new RejectedAttachments().reject(both, CORRUPT).map((item) => item.name)).toEqual(["bad.pdf"]);
    expect(new RejectedAttachments().reject(both, "Invalid image data").map((item) => item.name)).toEqual(["image"]);
    expect(new RejectedAttachments().reject(both, "Invalid content").map((item) => item.name)).toEqual(["bad.pdf", "image"]);
  });

  test("the suspects are the attachments no accepted request carried; they are replaced from then on", () => {
    const guard = new RejectedAttachments();
    guard.accept(attachmentsIn({ input: [{ type: "input_image", image_url: IMAGE }] }));
    const prepared = guard.prepare(responsesBody("two"));
    expect(guard.reject(prepared.attachments).map((item) => item.name)).toEqual(["bad.pdf"]);
    const next = guard.prepare(responsesBody("three"));
    expect(next.replaced).toEqual(["bad.pdf"]);
    expect(JSON.stringify(next.body)).toContain("[file could not be read: bad.pdf]");
    expect(JSON.stringify(next.body)).toContain(IMAGE);
    expect(replaceAttachments(next.body, () => false).body).toBe(next.body);
  });

  test("the broker sends the refused request again without the file, and leaves it out of later turns", async () => {
    const sent: string[] = [];
    const broker = new OmniRushGatewayBroker({
      credentials: { gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "access-token", refreshToken: "refresh-token" },
      engineToken: "local-engine-token",
      fetch: async (_input, init) => {
        const raw = init?.body;
        const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw as ArrayBuffer);
        sent.push(text);
        if (text.includes("data:application/pdf")) {
          return new Response(JSON.stringify({ error: { message: CORRUPT, type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "text/event-stream" } });
        }
        return new Response("data: ok\n\n", { headers: { "content-type": "text/event-stream" } });
      },
    });
    const turn = (prompt: string) => broker.handle(new Request("http://127.0.0.1/omnirush-gateway/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer local-engine-token", "Content-Type": "application/json" },
      body: JSON.stringify(responsesBody(prompt)),
    }), "responses");

    const first = await turn("what did you get?");
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("data: ok");
    expect(sent.length).toBe(2);
    expect(sent[1]).toContain("[file could not be read: bad.pdf]");
    expect(sent[1]).not.toContain("data:application/pdf");
    expect(sent[1]).toContain(IMAGE);

    const second = await turn("Create ok.txt containing ok");
    expect(second.status).toBe(200);
    await second.text();
    expect(sent.length).toBe(3);
    expect(sent[2]).not.toContain("data:application/pdf");
  });

  test("a 400 that is not about an attachment passes through once", async () => {
    let calls = 0;
    const broker = new OmniRushGatewayBroker({
      credentials: { gatewayUrl: "https://gateway.example/omnirush/v1", accessToken: "access-token", refreshToken: "refresh-token" },
      engineToken: "local-engine-token",
      fetch: async () => {
        calls += 1;
        return Response.json({ error: { message: "Unsupported parameter: 'max_output_tokens'" } }, { status: 400 });
      },
    });
    const response = await broker.handle(new Request("http://127.0.0.1/omnirush-gateway/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer local-engine-token", "Content-Type": "application/json" },
      body: JSON.stringify(responsesBody("x")),
    }), "responses");
    expect(response.status).toBe(400);
    expect(calls).toBe(1);
  });
});
