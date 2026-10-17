/** A synthetic coding-harness calculator: executes outside Canvas Agent and writes no CLI logs. */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

interface HarnessCalculation {
  operation: string
  result: number
  source?: { path: string }
}
export function harnessCalculations<T = HarnessCalculation[]>(args: string[]): T {
  const value = (flag: string) => args[args.indexOf(flag) + 1]
  const operations = args.includes("--file")
    ? JSON.parse(readFileSync(value("--file"), "utf8")).operations
    : [
        {
          operation: value("--operation"),
          values: value("--values").split(",").map(Number),
          source: args.includes("--source") ? value("--source") : undefined,
        },
      ]
  const script = `const ops=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(ops.map(o=>{const v=o.values;const f={sum:()=>v.reduce((a,b)=>a+b,0),mean:()=>v.reduce((a,b)=>a+b,0)/v.length,add:()=>v[0]+v[1],subtract:()=>v[0]-v[1],multiply:()=>v[0]*v[1],divide:()=>v[0]/v[1],power:()=>v[0]**v[1],min:()=>Math.min(...v),max:()=>Math.max(...v)};return {operation:o.operation,result:f[o.operation](),...(o.source?{source:{path:o.source}}:{})}})))`
  const results = JSON.parse(
    execFileSync(process.execPath, ["-e", script, JSON.stringify(operations)], {
      encoding: "utf8",
    }),
  )
  return results as T
}
