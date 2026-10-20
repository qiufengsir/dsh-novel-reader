import fs from "node:fs";
const read = (p) =>
  fs.readFileSync(new URL(p, import.meta.url), "utf8").replace(/^\uFEFF/, "");
const core = read("./src/core.cjs"),
  taskLink = read("./src/task-link.cjs"),
  ui = read("./src/reader.js"),
  css = read("./src/reader.css");
const id = "dsh-zhijian-reader";
const output = `window.__ModuleLoader__.load({id:${JSON.stringify(id)},factory:(require)=>{const React=require('react');\n${core}\n${taskLink}\n${ui}\nfunction apply(ctx){
function Reader({sessionId}){
  const ref=React.useRef(null),source=React.useRef(null);
  React.useEffect(()=>{
    const taskSource=ZhijianReaderTaskLink.createSource(ctx,sessionId);
    source.current=taskSource;
    const unmount=mountReader(ref.current,{taskSource});
    return()=>{source.current=null;unmount();taskSource.dispose();};
  },[]);
  React.useEffect(()=>{source.current?.setSession(sessionId);},[sessionId]);
  return React.createElement('div',{ref,style:{height:'100%',minHeight:0,flex:1}});
}
ctx.effect(()=>{const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);return()=>style.remove();});ctx.effect(()=>ctx.sidebarRightTabs.register({id:'${id}',kind:'dsh-zhijian-reader',multiple:false,priority:'extension',title:()=>'纸间 · 小说阅读器',guide:[{id:'new',order:35,title:()=>'纸间 · 小说阅读器',description:()=>'本地书架 · 开发任务联动',icon:()=>React.createElement('span',{'aria-hidden':true},'▤')}]}));ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:'${id}'},Reader)));}return {inject:['slots','sidebarRightTabs','sessions','uiSession'],apply};}});\n`;
fs.writeFileSync(new URL("./lib/client.js", import.meta.url), output);
console.log("Built lib/client.js");
