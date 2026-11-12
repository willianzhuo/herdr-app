import {test,expect} from "bun:test";
import {readFile} from "node:fs/promises";

const source=await readFile(new URL("../defaults/mods/file-download/main.js",import.meta.url),"utf8");
function element():any {
  const n:any={kids:[],methods:new Map()};
  const p:any=new Proxy(n,{get(t,k:string){if(k in t)return t[k];return (...args:any[])=>{
    if(k==="when")return args[0]?args[1](p):p;
    if(k==="child")t.kids.push(args[0]);
    if(k==="children")t.kids.push(...args[0]);
    t.methods.set(k,args);return p;
  };}});return p;
}
const nodes=(n:any):any[]=>n&&typeof n==="object"?[n,...(n.kids??[]).flatMap(nodes)]:[];
function harness(initial:any={}) {
  let props:any={path:"/remote/资料.bin",on:"200",directory:false,overlay:"download1",...initial},pick:any=null;
  const tasks:any[]=[],calls:any[]=[],notices:any[]=[],closed:any[]=[];
  const opened:any[]=[],values=new Map();
  let state:any={id:"job",phase:"queued",bytes:0,total:null};
  const cx:any={notify(){},timer:{every(){}},spawn(fn:any){tasks.push(fn(cx));}};
  const View=new Function("View","div","v_flex","h_flex","props","home","appHome","exec","settings","pickFolder","closeOverlay","openOverlay","shared","setShared","notify","theme","window",
    source.replace(/^import .*;\n/gm,"").replace("export default class FileDownload","class FileDownload")+";return FileDownload;")(
      class{},element,element,element,()=>props,()=>"/local",()=>"/app",async(...args:any[])=>{calls.push(args);return {code:0,stdout:JSON.stringify(state)};},
      ()=>({core:"/core/hc"}),async()=>pick,(id:any)=>closed.push(id),(spec:any)=>{opened.push(spec);return "details";},
      (key:string)=>values.get(key),(key:string,value:any)=>values.set(key,value),(n:any)=>notices.push(n),()=>({}),()=>({platform:"macos"}));
  const view=new View();view.init({},cx);
  const click=(id:string)=>nodes(view.render()).find(n=>n.methods?.get("id")?.[0]===id).methods.get("on_click")[0]({},cx);
  return {view,cx,click,calls,notices,closed,opened,values,setProps:(p:any)=>props=p,setPick:(p:any)=>pick=p,setState:(s:any)=>state=s,flush:async()=>{while(tasks.length)await Promise.all(tasks.splice(0));}};
}

test("download destination cancellation and focus changes preserve the captured source",async()=>{
  const h=harness();h.click("download-choose");await h.flush();
  expect(h.view.destination).toBe("/local/Downloads");expect(h.calls).toHaveLength(0);
  h.setPick("/local/selected");h.click("download-choose");await h.flush();
  h.setProps({path:"/wrong/file",on:"814",directory:true});
  h.click("download-start");h.click("download-start");await h.flush();
  expect(h.calls).toHaveLength(1);
  expect(JSON.parse(h.calls[0][1][3])).toEqual({path:"/remote/资料.bin",on:"200",directory:false,destination:"/local/selected",core:"/core/hc",transport:"auto"});
  h.click("download-close");expect(h.closed).toEqual(["download1"]);
  expect(h.calls).toHaveLength(1); // Closing UI doesn't send cancellation or terminal input.
});

test("closing details leaves a resumable background download; reopened details do not start another worker",async()=>{
  const h=harness();h.click("download-start");await h.flush();
  expect(h.values.get("file-download.detail.job").overlay).toBe("download1");
  h.view.close();expect(h.values.get("file-download.detail.job")).toBeNull();
  h.view.keepDetail();expect(h.values.get("file-download.detail.job")).toBeNull();
  const reopened=harness({job:"job",destination:"/selected"});await reopened.flush();
  expect(reopened.view.destination).toBe("/selected");
  expect(reopened.calls[0][1].slice(1)).toEqual(["status","/app","job"]);
  expect(reopened.calls.some(c=>c[1][1]==="start")).toBe(false);
});

test("background progress survives detail dismissal, follows multiple jobs and keeps completed results",async()=>{
  const h=harness({role:"progress"});
  await h.flush();
  const job={id:"first",phase:"downloading",bytes:1024,total:2048,source:{path:"/remote/资料.bin",on:"814",directory:false},destination:"/selected"};
  h.setState({jobs:[job,{...job,id:"second",phase:"complete",path:"/selected/资料.bin"}]});h.view.poll(h.cx);await h.flush();
  expect(h.calls[0][1][1]).toBe("list");
  const ids=()=>nodes(h.view.render()).map(n=>n.methods?.get("id")?.[0]);
  expect(ids()).toContain("download-job-first");expect(ids()).toContain("download-job-second");
  h.click("download-open-first");
  expect(h.opened[0]).toEqual({mod:"file-download",kind:"dialog",width:520,props:{...job.source,destination:"/selected",job:"first"}});
  h.view.openJob(job);expect(h.opened).toHaveLength(1);
  expect(ids()).not.toContain("download-job-first");
  h.values.set("file-download.detail.first",{overlay:"closed",at:Date.now()-6000});
  expect(ids()).toContain("download-job-first");
  h.click("downloads-collapse");expect(ids()).not.toContain("download-job-first");
  h.click("downloads-collapse");h.click("download-reveal-second");await h.flush();
  expect(h.calls.at(-1)).toEqual(["open",["-R","/selected/资料.bin"]]);
  h.setState({dismissed:"second"});h.click("download-dismiss-second");await h.flush();
  expect(h.calls.at(-1)[1].slice(1)).toEqual(["dismiss","/app","second"]);
  expect(ids()).not.toContain("download-job-second");
});

test("download progress completes with an exact local path and a single notification",async()=>{
  const h=harness();h.click("download-start");await h.flush();
  h.setState({id:"job",phase:"downloading",bytes:1024,total:2048});h.view.poll(h.cx);await h.flush();
  expect(nodes(h.view.render()).some(n=>n.kids?.some((v:any)=>typeof v==="string"&&v.includes("50%")))).toBe(true);
  h.setState({id:"job",phase:"complete",path:"/local/Downloads/资料.bin"});h.view.poll(h.cx);await h.flush();
  h.view.poll(h.cx);await h.flush();
  expect(h.notices).toEqual([{title:"下载完成",body:"/local/Downloads/资料.bin",level:"success",timeout:8000}]);
  h.click("download-reveal");await h.flush();
  expect(h.calls.at(-1)).toEqual(["open",["-R","/local/Downloads/资料.bin"]]);
});

test("explicit compatibility mode and SFTP status stay visible",async()=>{
  const h=harness();
  h.click("download-transport");h.click("download-start");await h.flush();
  expect(JSON.parse(h.calls[0][1][3]).transport).toBe("core");
  const labels=()=>nodes(h.view.render()).flatMap(n=>n.kids??[]).filter(v=>typeof v==="string").join(" ");
  h.setState({id:"job",phase:"connecting",transport:"SFTP",bytes:0,total:2048});h.view.poll(h.cx);await h.flush();
  expect(labels()).toContain("传输：SFTP");expect(labels()).toContain("正在连接 SFTP");
  h.setState({id:"job",phase:"verifying",transport:"SFTP",bytes:2048,total:2048});h.view.poll(h.cx);await h.flush();
  expect(labels()).toContain("正在校验下载");
  h.setState({id:"job",phase:"error",transport:"Core",transportDetail:"此连接没有可直接使用的 SSH 目标",error:"failed"});h.view.poll(h.cx);await h.flush();
  expect(labels()).toContain("Core 兼容模式 · 此连接没有可直接使用的 SSH 目标");
});

test("closing the progress float hides it without cancelling; history can reopen and clear only finished jobs",async()=>{
  const h=harness({role:"progress"});await h.flush();
  const active={id:"active",phase:"downloading",bytes:1,total:2,source:{path:"/work/file",on:"200"},destination:"/selected"};
  h.setState({jobs:[active]});h.view.poll(h.cx);await h.flush();
  const calls=h.calls.length;h.click("downloads-close");
  expect(h.values.get("file-download.progress-hidden")).toBe(true);
  expect(nodes(h.view.render()).some(n=>n.methods?.get("id")?.[0]==="download-progress")).toBe(false);
  expect(h.calls).toHaveLength(calls);
  h.setState({jobs:[{...active,phase:"complete",path:"/selected/file",updated:Date.now()/1000}]});h.view.poll(h.cx);await h.flush();
  expect(h.notices).toHaveLength(1);h.view.poll(h.cx);await h.flush();expect(h.notices).toHaveLength(1);
  const history=harness({role:"history"});await history.flush();
  history.values.set("file-download.progress-hidden",true);
  history.setState({jobs:[active,{...active,id:"done",phase:"complete"},{...active,id:"failed",phase:"error"}]});history.view.poll(history.cx);await history.flush();
  expect(nodes(history.view.render()).some(n=>n.methods?.get("id")?.[0]==="download-job-active")).toBe(true);
  history.setState({dismissed:"result"});history.click("downloads-clear");await history.flush();
  expect(history.calls.filter(c=>c[1][1]==="dismiss").map(c=>c[1][3])).toEqual(["done","failed"]);
  expect(history.view.jobs.map(j=>j.id)).toEqual(["active"]);
  history.click("downloads-close");expect(history.closed).toEqual(["download1"]);
  const next=harness();next.values.set("file-download.progress-hidden",true);next.click("download-start");await next.flush();
  expect(next.values.get("file-download.progress-hidden")).toBe(false);
});
