"use client"

import { SquareTerminalIcon } from "lucide-react"
import {
  CollapsibleTool,
  CollapsibleToolContent,
  CollapsibleToolStep,
  CollapsibleToolTrigger,
} from "@/components/tools/collapsible-tool"
import type { BashToolPart } from "@/lib/build-in-tools"
import { displayRuntimeBrand } from "@/lib/display-runtime-brand"

interface BashToolProps {
  part: BashToolPart
}

export function BashTool({ part }: BashToolProps) {
  return (
    <CollapsibleTool>
      <CollapsibleToolStep className="flex flex-col gap-2">
        <CollapsibleToolTrigger leftIcon={<SquareTerminalIcon className="size-4" />}>
          <span className="flex gap-2">
            <span className="shrink-0">
              {displayRuntimeBrand(part.input.description)}
            </span>
            <span className="opacity-80 truncate grow">
              {displayRuntimeBrand(part.input.command)}
            </span>
          </span>
        </CollapsibleToolTrigger>
        <CollapsibleToolContent className="bg-muted rounded-lg p-2">
          <div className="flex flex-col gap-2 text-xs">
            <pre>$ {displayRuntimeBrand(part.input.command)}</pre>
            <pre className="opacity-80">{displayRuntimeBrand(part.output ?? "")}</pre>
            <button
              type="button"
              className="self-start text-muted-foreground underline"
              onClick={() => void navigator.clipboard?.writeText(part.input.command)}
            >
              Copy exact command
            </button>
          </div>
        </CollapsibleToolContent>
      </CollapsibleToolStep>
    </CollapsibleTool>
  )
}
