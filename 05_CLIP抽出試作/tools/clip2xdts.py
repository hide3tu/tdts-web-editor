"""CLIP STUDIO .clip -> XDTS (one file per timeline), matching CLIP STUDIO PAINT EX's own export.

usage: python -I clip2xdts.py <in.clip> <out_dir>

Export rules (CSP manual + checked against EX output of mnk_03_C173_C176_C181_L_LOt1):
  - only visible animation folders (fieldId 0) / S0-S9 (fieldId 3) / 2D camera folders (fieldId 5)
  - Timeline palette bottom -> top  ==  XDTS left -> right
  - cell field: value on change, SYMBOL_NULL_CELL at the end of the last clip (may exceed duration);
    a folder with no clip in the timeline is [0: SYMBOL_NULL_CELL]
  - sound field: "[speaker]text" -> values ["speaker", "text"] at the start, SYMBOL_HYPHEN for the rest
  - camera field: track listed with no frames
"""
import sys, os, re, math, json, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from clip_sqlite import extract
from clipx import Clip, parse_binc, find

NULL = 'SYMBOL_NULL_CELL'
HYPHEN = 'SYMBOL_HYPHEN'
KIND_ANIM, KIND_CAMERA = 2000, 2005

def kids(n):
    return {k['name']: k for k in n['kids']}

def clips_of(root):
    """[(tl_start, tl_end, local_start, rate, [(local_t, celname), ...]), ...] in ticks."""
    out = []
    for ac in find(root, 'ActionNodeClip'):
        k = kids(ac)
        tc = {x['name']: x['value'] for x in k['TimeClip']['kids']}
        mc = {x['name']: x['value'] for x in k['MotionClip']['kids']}
        keys = []
        for fc in find(ac, 'FCurve'):
            if fc['attrs'].get('Type') != 'ImageCelName':
                continue
            kv = {x['name']: x['value'] for x in fc['kids']}
            keys += list(zip(kv['Frame'], kv['Tag']))
        if keys:
            out.append((tc['Start'], tc['End'], mc['Start'], tc['Rate'], sorted(keys)))
    return sorted(out)

def cel_at(clips, t):
    """(clip index, key index, cel name) at timeline tick t, or None outside every clip."""
    for ci, (s, e, ls, _, keys) in enumerate(clips):
        if s <= t < e:
            lt = t - s + ls
            ki = 0
            for i, (kt, _) in enumerate(keys):
                if kt <= lt + 1e-6:
                    ki = i
            return ci, ki, keys[ki][1]
    return None

def cell(frame, values):
    return {'data': [{'id': 0, 'values': values}], 'frame': frame}

def track_frames(clips, field, sf, fps):
    if not clips:
        return [cell(0, [NULL])] if field == 0 else []
    rate = clips[0][3]
    last = int(math.ceil(max(e for _, e, _, _, _ in clips) / rate * fps - sf - 1e-6))
    frames, prev = [], None
    for f in range(last):
        at = cel_at(clips, (sf + f) / fps * rate)
        if field == 0:
            v = at[2] if at else NULL
            if v != prev:
                frames.append(cell(f, [v]))
            prev = v
        elif at:
            if at[:2] != prev:
                m = re.fullmatch(r'\[(.*?)\](.*)', at[2], re.S)
                frames.append(cell(f, [m[1], m[2]] if m else [at[2]]))
            else:
                frames.append(cell(f, [HYPHEN]))
            prev = at[:2]
        else:
            prev = None
    if field == 0:
        frames.append(cell(last, [NULL]))
    return frames

def dump(o):
    """CSP's layout: one token per line, no indent, empty arrays as '[\\n]'."""
    if isinstance(o, dict):
        return '{\n' + ',\n'.join(f'{json.dumps(k, ensure_ascii=False)}:{dump(v)}' for k, v in o.items()) + '\n}'
    if isinstance(o, list):
        return '[\n' + ',\n'.join(dump(v) for v in o) + ('\n]' if o else ']')
    return json.dumps(o, ensure_ascii=False)

def convert(path, out_dir):
    db = os.path.join(tempfile.mkdtemp(), 'c.db')
    extract(path, db)
    c = Clip(path, db)
    lay = {u.replace('-', '').upper(): (mid, n) for u, mid, n in
           c.con.execute("select LayerUuid, MainId, LayerName from Layer where LayerUuid is not null")}
    # layer tree -> effective visibility (the layer and every ancestor folder visible)
    rows = {r[0]: r[1:] for r in c.con.execute(
        "select MainId, LayerFirstChildIndex, LayerNextIndex, LayerVisibility from Layer")}
    parent = {}
    for mid, (fc, _, _) in rows.items():
        ch = fc
        while ch:
            parent[ch] = mid
            ch = rows[ch][1]
    def visible(mid):
        while mid:
            if not rows[mid][2] & 1:
                return False
            mid = parent.get(mid)
        return True
    # stored sibling order is bottom -> top, which is XDTS left -> right
    order = {}
    def walk(i):
        while i:
            order[i] = len(order)
            walk(rows[i][0])
            i = rows[i][1]
    walk(rows[c.con.execute("select CanvasRootFolder from Canvas").fetchone()[0]][0])
    tr = {r[0]: r for r in c.con.execute(
        "select MainId, TrackNextIndex, TrackKind, TrackActionMixer, LayerUuidWithTrack from Track")}
    base = os.path.splitext(os.path.basename(path))[0]
    report = []
    for name, fps, sf, ef, first, scene, cut in c.con.execute(
            "select TimeLineName, FrameRate, StartFrame, EndFrame, FirstTrack,"
            " SceneIndexForName, CutIndexForName from TimeLine"):
        found = []
        t = first
        while t:
            mid, nxt, kind, mixer, u = tr[t]
            t = nxt
            lmid, lname = lay.get(bytes(u).hex().upper(), (None, '?'))
            if kind not in (KIND_ANIM, KIND_CAMERA) or not visible(lmid):
                continue
            if kind == KIND_CAMERA:
                field, frames = 5, []
            else:
                field = 3 if re.fullmatch(r'S[0-9]', lname) else 0
                frames = track_frames(clips_of(parse_binc(c.ext(mixer))), field, sf, fps)
            found.append((order.get(lmid, 1 << 30), field, lname, frames))
        found.sort(key=lambda x: x[0])
        fields, headers = [], []
        for fid in (0, 3, 5):
            items = [x for x in found if x[1] == fid]
            if not items:
                continue
            fields.append({'tracks': [{'trackNo': i, 'frames': fr} for i, (_, _, _, fr) in enumerate(items)],
                           'fieldId': fid})
            headers.append({'names': [n for _, _, n, _ in items], 'fieldId': fid})
        xdts = {'timeTables': [{'duration': int(round(ef - sf)), 'fields': fields, 'name': name,
                                'timeTableHeaders': headers}],
                'version': 5,
                'header': {'cut': str(cut), 'scene': str(scene)}}
        out = os.path.join(out_dir, f'{base}__{name}.xdts')
        with open(out, 'w', encoding='utf-8', newline='\n') as fp:
            fp.write('exchangeDigitalTimeSheet Save Data\n' + dump(xdts))
        report.append((name, fps, int(round(ef - sf)), [(f, n, fr) for _, f, n, fr in found]))
    c.con.close()
    return report

if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    src, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    for name, fps, dur, tracks in convert(src, out_dir):
        print(f'  {name}: {fps:g}fps {dur}f  tracks={len(tracks)}')
        for field, n, frames in tracks:
            seq = ' '.join(f"{x['frame']}:{'/'.join(x['data'][0]['values'])}" for x in frames
                           if x['data'][0]['values'] != [HYPHEN])
            print(f'    [f{field}] {n}: {seq[:150]}{"…" if len(seq) > 150 else ""}')
