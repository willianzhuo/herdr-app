import {test,expect} from "bun:test";
import {readFile} from "node:fs/promises";

const source=await readFile(new URL("../defaults/mods/file-download/main.js",import.meta.url),"utf8");
function element():any {
  const n:any={kids:[],methods:new Map()};
  const p:any=new Proxy(n,{get(t,k:string){if(k in t)return t[k];return (...args:any[])=>{
    if(k==="when")return args[0]?args[1](p):p;
    if(k==="child")t.kids.push(args[0]);
    t.methods.set(k,args);return p;
  };}});return p;
}
const nodes=(n:any):any[]=>n&&typeof n==="object"?[n,...(n.kids??[]).flatMap(nodes)]:[];
function harness() {
  let props:any={path:"/remote/资料.bin",on:"200",directory:false,overlay:"download1"},pick:any=null;
  const tasks:any[]=[],calls:any[]=[],notices:any[]=[],closed:any[]=[];
  let state:any={id:"job",phase:"queued",bytes:0,total:null};
  const cx:any={notify(){},timer:{every(){}},spawn(fn:any){tasks.push(fn(cx));}};
  const View=new Function("View","div","v_flex","h_flex","props","home","appHome","exec","settings","pickFolder","closeOverlay","notify","theme","window",
    source.replace(/^import .*;\n/gm,"").replace("export default class FileDownload","class FileDownload")+";return FileDownload;")(
      class{},element,element,element,()=>props,()=>"/local",()=>"/app",async(...args:any[])=>{calls.push(args);return {code:0,stdout:JSON.stringify(state)};},
      ()=>({core:"/core/hc"}),async()=>pick,(id:any)=>closed.push(id),(n:any)=>notices.push(n),()=>({}),()=>({platform:"macos"}));
  const view=new View();view.init({},cx);
  const click=(id:string)=>nodes(view.render()).find(n=>n.methods?.get("id")?.[0]===id).methods.get("on_click")[0]({},cx);
  return {view,cx,click,calls,notices,closed,setProps:(p:any)=>props=p,setPick:(p:any)=>pick=p,setState:(s:any)=>state=s,flush:async()=>{while(tasks.length)await Promise.all(tasks.splice(0));}};
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
