import sqlite3,struct,zlib
class Clip:
    def __init__(s,path,db):
        s.data=open(path,'rb').read(); s.con=sqlite3.connect(db)
        s.offs={(k if isinstance(k,bytes) else k.encode()):v for k,v in s.con.execute("select ExternalID,Offset from ExternalChunk")}
    def ext(s,eid):
        eid=eid if isinstance(eid,bytes) else eid.encode()
        o=s.offs[eid]+16
        n=struct.unpack('>Q',s.data[o:o+8])[0]; o+=8+n
        sz=struct.unpack('>Q',s.data[o:o+8])[0]; o+=8
        body=s.data[o:o+sz]
        raw=struct.unpack('<I',body[:4])[0]
        return zlib.decompress(body[4:]) if body[4:5]==b'x' else body

def parse_binc(d):
    """CELSYS 'cmt 0100binc' serialized tree (TrackActionMixer v0100)."""
    assert d[:12]==b'cmt 0100binc', d[:12]
    p=16; n=struct.unpack('<I',d[p:p+4])[0]; p+=4
    strs=[]
    for _ in range(n):
        l=d[p]; p+=1; strs.append(d[p:p+l].decode('utf-8','replace')); p+=l
    def u32():
        nonlocal p; v=struct.unpack('<I',d[p:p+4])[0]; p+=4; return v
    def val(t):
        nonlocal p
        T=strs[t]
        if T=='null': return None
        if T in('Byte','SByte'): v=d[p]; p+=1; return v
        if T in('UInt16','Int16'): v=struct.unpack('<h' if T=='Int16' else '<H',d[p:p+2])[0]; p+=2; return v
        if T in('UInt32','Int32'): v=struct.unpack('<i' if T=='Int32' else '<I',d[p:p+4])[0]; p+=4; return v
        if T=='Single': v=struct.unpack('<f',d[p:p+4])[0]; p+=4; return v
        if T=='Double': v=struct.unpack('<d',d[p:p+8])[0]; p+=8; return v
        if T=='String': return strs[u32()]
        if T.endswith('[]'):
            k=u32(); b=T[:-2]
            return [val(strs.index(b)) for _ in range(k)]
        sz={'Float2':8,'Float3':12,'Quat':16,'Matrix44':64}[T]
        v=struct.unpack('<%df'%(sz//4),d[p:p+sz]); p+=sz; return v
    def node():
        name=strs[u32()]; t=u32(); v=val(t)
        attrs={strs[u32()]:strs[u32()] for _ in range(u32())}
        kids=[node() for _ in range(u32())]
        return {'name':name,'value':v,'attrs':attrs,'kids':kids}
    return node()

def find(n,name):
    if n['name']==name: yield n
    for k in n['kids']: yield from find(k,name)
import sys; sys.stdout.reconfigure(encoding='utf-8')
