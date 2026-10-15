// CLIP STUDIO .clip -> XDTS ------------------------------------------------
// Reads the SQLite database embedded in a .clip file and rebuilds the XDTS
// that CLIP STUDIO PAINT EX would export for one timeline (verified to be
// byte-identical against EX output). No external libraries.
const ClipReader=(()=>{
  const NULL='SYMBOL_NULL_CELL',HYPHEN='SYMBOL_HYPHEN',KIND_ANIM=2000,KIND_CAMERA=2005;
  const td=new TextDecoder('utf-8');
  const ascii=(u8,p,n)=>String.fromCharCode(...u8.subarray(p,p+n));
  const be64=(dv,p)=>Number(dv.getBigUint64(p,false));
  const str=v=>typeof v==='string'?v:td.decode(v);

  // .clip container: 'CSFCHUNK' header, then [8-byte name][BE u64 size][body] chunks
  function chunks(u8){
    if(ascii(u8,0,8)!=='CSFCHUNK')throw new Error('CLIPファイルではありません');
    const dv=new DataView(u8.buffer,u8.byteOffset,u8.byteLength);
    let p=24,sqlite=null;
    while(p+16<=u8.length){
      const name=ascii(u8,p,8),size=be64(dv,p+8);
      if(name==='CHNKSQLi')sqlite=u8.subarray(p+16,p+16+size);
      p+=16+size;
    }
    if(!sqlite)throw new Error('CLIP内にデータベースが見つかりません');
    return {dv,sqlite};
  }

  // Minimal read-only SQLite reader (rowid tables only) ---------------------
  function openSqlite(db){
    const dv=new DataView(db.buffer,db.byteOffset,db.byteLength);
    let pageSize=dv.getUint16(16);if(pageSize===1)pageSize=65536;
    const usable=pageSize-db[20];
    const page=n=>(n-1)*pageSize;
    function varint(p){let v=0;for(let i=0;i<8;i++){const b=db[p+i];v=v*128+(b&127);if(b<128)return [v,i+1]}return [v*256+db[p+8],9]}
    function payload(p,n){
      // local part + overflow chain (table b-tree leaf rules)
      const X=usable-35;
      if(n<=X)return db.subarray(p,p+n);
      const M=Math.floor((usable-12)*32/255)-23,K=M+(n-M)%(usable-4),local=K<=X?K:M;
      const out=new Uint8Array(n);out.set(db.subarray(p,p+local));
      let got=local,ov=dv.getUint32(p+local);
      while(got<n&&ov){const o=page(ov),take=Math.min(n-got,usable-4);out.set(db.subarray(o+4,o+4+take),got);got+=take;ov=dv.getUint32(o)}
      return out;
    }
    function record(b){
      const rdv=new DataView(b.buffer,b.byteOffset,b.byteLength);
      const vi=p=>{let v=0;for(let i=0;i<8;i++){const x=b[p+i];v=v*128+(x&127);if(x<128)return [v,i+1]}return [v*256+b[p+8],9]};
      const [hsz,q]=vi(0),types=[];let hp=q;
      while(hp<hsz){const [t,l]=vi(hp);types.push(t);hp+=l}
      let p=hsz;const vals=[];
      for(const t of types){
        let v=null;
        if(t===0)v=null;
        else if(t>=1&&t<=6){const n=[0,1,2,3,4,6,8][t];let x=b[p]&0x80?-1n:0n;for(let i=0;i<n;i++)x=(x<<8n)|BigInt(b[p+i]);x=BigInt.asIntN(n*8,x);v=Number(x);p+=n}
        else if(t===7){v=rdv.getFloat64(p);p+=8}
        else if(t===8)v=0;else if(t===9)v=1;
        else if(t>=12&&t%2===0){const n=(t-12)/2;v=b.slice(p,p+n);p+=n}
        else if(t>=13){const n=(t-13)/2;v=td.decode(b.subarray(p,p+n));p+=n}
        vals.push(v);
      }
      return vals;
    }
    function scan(root,cb){
      const o=page(root),h=root===1?100:0,type=db[o+h],n=dv.getUint16(o+h+3);
      if(type===0x05){
        for(let i=0;i<n;i++)scan(dv.getUint32(o+dv.getUint16(o+h+12+i*2)),cb);
        scan(dv.getUint32(o+h+8),cb);
      }else if(type===0x0D){
        for(let i=0;i<n;i++){
          let p=o+dv.getUint16(o+h+8+i*2);
          const [len,a]=varint(p);p+=a;const [rowid,b]=varint(p);p+=b;
          cb(record(payload(p,len)),rowid);
        }
      }else throw new Error('未対応のSQLiteページ種別 '+type);
    }
    const tables={};
    scan(1,r=>{if(r[0]==='table')tables[r[1]]={root:r[3],sql:r[4]}});
    function columns(sql){
      const body=sql.slice(sql.indexOf('(')+1,sql.lastIndexOf(')'));
      return body.split(',').map(s=>s.trim().split(/\s+/)[0].replace(/^["`\[]|["`\]]$/g,''));
    }
    // rows as objects; columns added later by ALTER TABLE may be missing (=null)
    function rows(name){
      const t=tables[name];if(!t)return [];
      const cols=columns(t.sql),out=[];
      scan(t.root,r=>{const o={};cols.forEach((c,i)=>o[c]=i<r.length?r[i]:null);out.push(o)});
      return out;
    }
    return {rows};
  }

  // External chunk: CHNKExta [size] [BE u64 idlen][id][BE u64 datalen][LE u32 raw][zlib]
  async function external(u8,dv,offset){
    let p=offset+16;const idlen=be64(dv,p);p+=8+idlen;
    const n=be64(dv,p);p+=8;
    const body=u8.subarray(p,p+n);
    if(body[4]!==0x78)return body;
    const ds=new DecompressionStream('deflate');
    const out=new Response(new Blob([body.subarray(4)]).stream().pipeThrough(ds));
    return new Uint8Array(await out.arrayBuffer());
  }

  // CELSYS 'cmt 0100binc' tree
  function parseBinc(d){
    if(ascii(d,0,12)!=='cmt 0100binc')throw new Error('未対応のトラック形式 '+ascii(d,0,12));
    const dv=new DataView(d.buffer,d.byteOffset,d.byteLength);
    let p=16;const u32=()=>{const v=dv.getUint32(p,true);p+=4;return v};
    const n=u32(),strs=[];
    for(let i=0;i<n;i++){const l=d[p++];strs.push(td.decode(d.subarray(p,p+l)));p+=l}
    const vec={Float2:2,Float3:3,Quat:4,Matrix44:16};
    function val(T){
      if(T==='null')return null;
      if(T==='Byte'||T==='SByte')return d[p++];
      if(T==='UInt16'){const v=dv.getUint16(p,true);p+=2;return v}
      if(T==='Int16'){const v=dv.getInt16(p,true);p+=2;return v}
      if(T==='UInt32'){return u32()}
      if(T==='Int32'){const v=dv.getInt32(p,true);p+=4;return v}
      if(T==='Single'){const v=dv.getFloat32(p,true);p+=4;return v}
      if(T==='Double'){const v=dv.getFloat64(p,true);p+=8;return v}
      if(T==='String')return strs[u32()];
      if(T.endsWith('[]')){const k=u32(),b=T.slice(0,-2),a=[];for(let i=0;i<k;i++)a.push(val(b));return a}
      if(vec[T]){const a=[];for(let i=0;i<vec[T];i++){a.push(dv.getFloat32(p,true));p+=4}return a}
      throw new Error('未知の型 '+T);
    }
    function node(){
      const name=strs[u32()],value=val(strs[u32()]),attrs={},kids=[];
      for(let i=u32();i>0;i--){const k=strs[u32()];attrs[k]=strs[u32()]}
      for(let i=u32();i>0;i--)kids.push(node());
      return {name,value,attrs,kids};
    }
    return node();
  }
  function* find(n,name){if(n.name===name)yield n;for(const k of n.kids)yield* find(k,name)}
  const kv=n=>Object.fromEntries(n.kids.map(k=>[k.name,k.value]));

  function clipsOf(root){
    const out=[];
    for(const ac of find(root,'ActionNodeClip')){
      const k=Object.fromEntries(ac.kids.map(x=>[x.name,x]));
      const tc=kv(k.TimeClip),mc=kv(k.MotionClip),keys=[];
      for(const fc of find(ac,'FCurve')){
        if(fc.attrs.Type!=='ImageCelName')continue;
        const c=kv(fc);c.Frame.forEach((f,i)=>keys.push([f,c.Tag[i]]));
      }
      if(keys.length){keys.sort((a,b)=>a[0]-b[0]||(a[1]<b[1]?-1:a[1]>b[1]?1:0));out.push([tc.Start,tc.End,mc.Start,tc.Rate,keys])}
    }
    return out.sort((a,b)=>a[0]-b[0]||a[1]-b[1]||a[2]-b[2]);
  }
  function celAt(clips,t){
    for(let ci=0;ci<clips.length;ci++){
      const [s,e,ls,,keys]=clips[ci];
      if(s<=t&&t<e){const lt=t-s+ls;let ki=0;keys.forEach(([kt],i)=>{if(kt<=lt+1e-6)ki=i});return [ci,ki,keys[ki][1]]}
    }
    return null;
  }
  const cell=(frame,values)=>({data:[{id:0,values}],frame});
  function trackFrames(clips,field,sf,fps){
    if(!clips.length)return field===0?[cell(0,[NULL])]:[];
    const rate=clips[0][3];
    const last=Math.ceil(Math.max(...clips.map(c=>c[1]))/rate*fps-sf-1e-6);
    const frames=[];let prev=null;
    for(let f=0;f<last;f++){
      const at=celAt(clips,(sf+f)/fps*rate);
      if(field===0){const v=at?at[2]:NULL;if(v!==prev)frames.push(cell(f,[v]));prev=v}
      else if(at){
        const key=at[0]+':'+at[1];
        if(key!==prev){const m=/^\[(.*?)\]([\s\S]*)$/.exec(at[2]);frames.push(cell(f,m?[m[1],m[2]]:[at[2]]))}
        else frames.push(cell(f,[HYPHEN]));
        prev=key;
      }else prev=null;
    }
    if(field===0)frames.push(cell(last,[NULL]));
    return frames;
  }
  const hex=b=>Array.from(b,x=>x.toString(16).padStart(2,'0')).join('').toUpperCase();

  // open(.clip bytes) -> {timelines:[{name,fps,duration}], build(index) -> Promise<xdts object>}
  function open(buffer){
    const u8=new Uint8Array(buffer),{dv,sqlite}=chunks(u8),db=openSqlite(sqlite);
    const ext=new Map(db.rows('ExternalChunk').map(r=>[str(r.ExternalID),r.Offset]));
    const L=db.rows('Layer'),byId=new Map(L.map(r=>[r.MainId,r]));
    const byUuid=new Map(L.filter(r=>r.LayerUuid).map(r=>[r.LayerUuid.replace(/-/g,'').toUpperCase(),r]));
    const parent=new Map();
    for(const r of L){let c=r.LayerFirstChildIndex;while(c){parent.set(c,r.MainId);c=byId.get(c).LayerNextIndex}}
    const visible=id=>{while(id){if(!(byId.get(id).LayerVisibility&1))return false;id=parent.get(id)}return true};
    // stored sibling order is bottom -> top == XDTS left -> right
    const order=new Map();
    const walk=i=>{while(i){order.set(i,order.size);walk(byId.get(i).LayerFirstChildIndex);i=byId.get(i).LayerNextIndex}};
    walk(byId.get(db.rows('Canvas')[0].CanvasRootFolder).LayerFirstChildIndex);
    const tracks=new Map(db.rows('Track').map(r=>[r.MainId,r]));
    const tls=db.rows('TimeLine');
    // TimeLine rows are a linked list from AnimationCutBank.FirstTimeLine
    const tlById=new Map(tls.map(r=>[r.MainId,r])),list=[];
    let t=db.rows('AnimationCutBank')[0]?.FirstTimeLine;
    while(t&&tlById.has(t)&&!list.includes(tlById.get(t))){list.push(tlById.get(t));t=tlById.get(t).NextTimeLine}
    for(const r of tls)if(!list.includes(r))list.push(r);
    async function build(i){
      const tl=list[i],sf=tl.StartFrame,fps=tl.FrameRate,found=[];
      for(let id=tl.FirstTrack;id;){
        const tr=tracks.get(id);id=tr.TrackNextIndex;
        const lay=byUuid.get(hex(tr.LayerUuidWithTrack||[]));
        if((tr.TrackKind!==KIND_ANIM&&tr.TrackKind!==KIND_CAMERA)||!lay||!visible(lay.MainId))continue;
        let field,frames;
        if(tr.TrackKind===KIND_CAMERA){field=5;frames=[]}
        else{
          field=/^S[0-9]$/.test(lay.LayerName)?3:0;
          const mixer=await external(u8,dv,ext.get(str(tr.TrackActionMixer)));
          frames=trackFrames(clipsOf(parseBinc(mixer)),field,sf,fps);
        }
        found.push({ord:order.get(lay.MainId)??Infinity,field,name:lay.LayerName,frames});
      }
      found.sort((a,b)=>a.ord-b.ord);
      const fields=[],headers=[];
      for(const fid of [0,3,5]){
        const items=found.filter(x=>x.field===fid);if(!items.length)continue;
        fields.push({tracks:items.map((x,i)=>({trackNo:i,frames:x.frames})),fieldId:fid});
        headers.push({names:items.map(x=>x.name),fieldId:fid});
      }
      const duration=Math.round(tl.EndFrame-sf);
      return {timeTables:[{duration,fields,name:tl.TimeLineName,timeTableHeaders:headers}],version:5,
              header:{cut:String(tl.CutIndexForName),scene:String(tl.SceneIndexForName)}};
    }
    return {timelines:list.map(r=>({name:r.TimeLineName,fps:r.FrameRate,duration:Math.round(r.EndFrame-r.StartFrame)})),build};
  }
  // CSP's own layout: one token per line, no indent, empty arrays as "[\n]"
  function dump(o){
    if(Array.isArray(o))return '[\n'+o.map(dump).join(',\n')+(o.length?'\n]':']');
    if(o&&typeof o==='object')return '{\n'+Object.entries(o).map(([k,v])=>JSON.stringify(k)+':'+dump(v)).join(',\n')+'\n}';
    return JSON.stringify(o);
  }
  const toText=x=>'exchangeDigitalTimeSheet Save Data\n'+dump(x);
  return {open,toText};
})();
if(typeof module!=='undefined')module.exports=ClipReader;
