"""Bounded process-tree RSS sampler for a task-owned command."""
import argparse,json,os,subprocess,time
from pathlib import Path
p=argparse.ArgumentParser(); p.add_argument("--output",required=True); p.add_argument("--interval",type=float,default=.02); p.add_argument("--timeout",type=float,default=180); p.add_argument("command",nargs=argparse.REMAINDER); a=p.parse_args()
cmd=a.command[1:] if a.command and a.command[0]=="--" else a.command
proc=subprocess.Popen(cmd,start_new_session=True)
started=time.monotonic(); peak=0; samples=0; peak_n=0; last_tree=[]
def tree(root):
    children={}
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit(): continue
        try:
            text=(entry/"stat").read_text(); rest=text[text.rfind(")")+2:].split()
            children.setdefault(int(rest[1]),[]).append(int(entry.name))
        except (OSError,ValueError,IndexError): pass
    result=[]; pending=[root]
    while pending:
        pid=pending.pop(); result.append(pid); pending+=children.get(pid,[])
    return result
while proc.poll() is None:
    if time.monotonic()-started>a.timeout:
        os.killpg(proc.pid,15); proc.wait(timeout=10); raise TimeoutError("task-owned benchmark timed out")
    pids=tree(proc.pid); total=0
    for pid in pids:
        try:
            line=next(l for l in Path(f"/proc/{pid}/status").read_text().splitlines() if l.startswith("VmRSS:"))
            total+=int(line.split()[1])*1024
        except (OSError,StopIteration,ValueError): pass
    if total>peak: peak=total; last_tree=pids
    peak_n=max(peak_n,len(pids)); samples+=1; time.sleep(a.interval)
result={"peak_tree_rss_bytes":peak,"elapsed_s":round(time.monotonic()-started,4),"samples":samples,"peak_process_count":peak_n,"exit_code":proc.returncode,"interval_s":a.interval,"command":cmd}
Path(a.output).write_text(json.dumps(result,indent=2)); print(json.dumps(result))
raise SystemExit(proc.returncode)
