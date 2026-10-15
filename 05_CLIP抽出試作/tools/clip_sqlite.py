"""Extract the embedded SQLite DB from a CLIP STUDIO .clip file and dump schema/rows."""
import sqlite3, struct, sys, os

def extract(path, out):
    data = open(path, 'rb').read()
    assert data[:8] == b'CSFCHUNK', 'not a clip'
    pos = 24
    chunks = []
    while pos < len(data):
        name = data[pos:pos+8]
        size = struct.unpack('>Q', data[pos+8:pos+16])[0]
        chunks.append((name.decode('ascii', 'replace'), size))
        if name == b'CHNKSQLi':
            open(out, 'wb').write(data[pos+16:pos+16+size])
        pos += 16 + size
    return chunks

if __name__ == '__main__':
    src, out = sys.argv[1], sys.argv[2]
    chunks = extract(src, out)
    from collections import Counter
    print('chunks:', Counter(c for c, _ in chunks))
    con = sqlite3.connect(out)
    for (t,) in con.execute("select name from sqlite_master where type='table' order by name"):
        n = con.execute(f'select count(*) from "{t}"').fetchone()[0]
        cols = [r[1] for r in con.execute(f'pragma table_info("{t}")')]
        print(f'{t} ({n}): {", ".join(cols)}')
