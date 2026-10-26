/* ============================================================================
 * part_zip —— ZIP 图片包导入导出（store 模式手写实现，零依赖）
 * zipBuild/unzip/readEntry 自旧版 L1598–1680 原样搬运；差异：
 *   · 导出：图片字节从服务端 /data/<path> 拉取（服务端是唯一存文件的地方）
 *   · 导入：解包后图片经 API.upload 落回 covers/ shots/，再按番号去重合并
 * ======================================================================== */
var CRCT = (function(){
  var t = [], c, n, k;
  for(n = 0; n < 256; n++){ c = n; for(k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; }
  return t;
})();
function crc32(buf){
  var c = 0xFFFFFFFF;
  for(var i = 0; i < buf.length; i++) c = CRCT[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function u8(str){ return new TextEncoder().encode(str); }
function zipBuild(files){
  var parts = [], central = [], offset = 0, i;
  files.forEach(function(f){
    var nb = u8(f.name), data = f.data, crc = crc32(data);
    var lh = new Uint8Array(30 + nb.length), lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true); lv.setUint16(10, 0, true); lv.setUint16(12, 0x2821, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, nb.length, true); lv.setUint16(28, 0, true);
    lh.set(nb, 30);
    var ch = new Uint8Array(46 + nb.length), cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true); cv.setUint16(12, 0, true); cv.setUint16(14, 0x2821, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, nb.length, true); cv.setUint16(30, 0, true); cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true); cv.setUint16(36, 0, true); cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true);
    ch.set(nb, 46);
    parts.push(lh, data); central.push(ch);
    offset += lh.length + data.length;
  });
  var cdSize = central.reduce(function(a, c){ return a + c.length; }, 0);
  var eocd = new Uint8Array(22), ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, 0, true); ev.setUint16(6, 0, true);
  ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true); ev.setUint16(20, 0, true);
  var total = offset + cdSize + 22;
  var out = new Uint8Array(total), pos = 0;
  for(i = 0; i < parts.length; i++){ out.set(parts[i], pos); pos += parts[i].length; }
  for(i = 0; i < central.length; i++){ out.set(central[i], pos); pos += central[i].length; }
  out.set(eocd, pos);
  return out;
}
function unzip(buf){
  var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  var i, eocd = -1;
  for(i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--){
    if(dv.getUint32(i, true) === 0x06054b50){ eocd = i; break; }
  }
  if(eocd === -1) return Promise.reject(new Error('不是有效的 zip 文件'));
  var count = dv.getUint16(eocd + 10, true);
  var cdOff = dv.getUint32(eocd + 16, true);
  var dec = new TextDecoder(), out = [], p = cdOff, jobs = [];
  for(i = 0; i < count; i++){
    if(dv.getUint32(p, true) !== 0x02014b50) break;
    var method = dv.getUint16(p + 10, true);
    var csize = dv.getUint32(p + 20, true);
    var nlen = dv.getUint16(p + 28, true);
    var elen = dv.getUint16(p + 30, true);
    var clen = dv.getUint16(p + 32, true);
    var loff = dv.getUint32(p + 42, true);
    var name = dec.decode(new Uint8Array(buf.buffer, buf.byteOffset + p + 46, nlen));
    var dlen = dv.getUint16(loff + 26, true);
    var dxlen = dv.getUint16(loff + 28, true);
    var dstart = loff + 30 + dlen + dxlen;
    var raw = new Uint8Array(buf.buffer, buf.byteOffset + dstart, csize);
    jobs.push(readEntry(raw, method, name));
    p += 46 + nlen + elen + clen;
  }
  return Promise.all(jobs).then(function(list){
    return list.filter(function(x){ return !!x; });
  });
}
function readEntry(raw, method, name){
  if(method === 0) return Promise.resolve({ name: name, data: raw });
  if(method === 8 && typeof DecompressionStream === 'function'){
    return new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw')))
      .arrayBuffer().then(function(b){ return { name: name, data: new Uint8Array(b) }; })
      .catch(function(){ return null; });
  }
  return Promise.resolve(null);
}
/* 从服务端拉图片字节 */
function imgBytesFromServer(img){
  var src = imgSrc(img);
  if(!src) return Promise.resolve(null);
  return fetch(apiUrl(src)).then(function(r){ return r.ok ? r.arrayBuffer() : null; })
    .then(function(b){ return b ? new Uint8Array(b) : null; })
    .catch(function(){ return null; });
}
/* 导出图片包：解压后就是一个完整文件夹（Film Library.json + covers/ + shots/） */
/* v2.1.27 BUG-18：旧版一次性 Promise.all 全部图片——262 行 × 数十张图会同时
   打出几百个请求，且全部字节驻留内存直到打包，大图库直接 OOM / 卡死。
   改为「任务队列 + 限并发 6」逐批推进。 */
function exportZip(){
  if(!state.rows.length){ toast('当前没有数据可导出'); return; }
  var files = [], jobs = [];
  var payload = { app: 'Film Library', version: 3, exportedAt: new Date().toISOString(), rows: [] };
  state.rows.forEach(function(r){
    var o = stripRow(r);
    payload.rows.push(o);
    if(r.cover){
      var p1 = r.cover.path || ('covers/' + r.cover.name);
      jobs.push(function(){ return imgBytesFromServer(r.cover).then(function(b){ if(b) files.push({ name: p1, data: b }); }); });
    }
    r.shots.forEach(function(s){
      var p2 = s.path || ('shots/' + s.name);
      jobs.push(function(){ return imgBytesFromServer(s).then(function(b){ if(b) files.push({ name: p2, data: b }); }); });
    });
  });
  var CONC = 6, at = 0, total = jobs.length;
  if(total) toast('正在打包 ' + total + ' 个图片文件…', 'ok');
  function runBatch(){
    var batch = jobs.slice(at, at + CONC);
    if(!batch.length) return Promise.resolve();
    at += CONC;
    return Promise.all(batch.map(function(fn){ return fn(); })).then(runBatch);
  }
  runBatch().then(function(){
    files.unshift({ name: 'Film Library.json', data: u8(JSON.stringify(payload, null, 2)) });
    download('Film Library 图片包_' + stamp() + '.zip', new Blob([zipBuild(files)], { type: 'application/zip' }));
    toast('已导出图片包，共 ' + files.length + ' 个文件', 'ok');
  }).catch(function(e){ toast('导出失败：' + ((e && e.message) || e), 'err'); });
}
/* 导入图片包：图片先上传服务端，再合并数据 */
function importZipFile(f){
  var rd = new FileReader();
  rd.onload = function(){
    unzip(new Uint8Array(rd.result)).then(function(files){
      var je = null, i;
      for(i = 0; i < files.length; i++){ if(/\.json$/i.test(files[i].name)){ je = files[i]; break; } }
      if(!je) throw new Error('压缩包里没找到数据 json');
      var payload = JSON.parse(new TextDecoder().decode(je.data));
      var list = Array.isArray(payload) ? payload : (payload.rows || []);
      var map = {};
      files.forEach(function(x){ map[x.name] = x.data; });
      var added = 0, skipped = 0, jobs = [];
      list.forEach(function(item){
        if(!item || !item.code) return;
        var code = fromJavdbCode(normCode(item.code));
        if(!code) return;
        if(rowByCode(code)){ skipped++; return; }
        var row = normalizeRow({
          id: uid(), code: code, title: item.title, titleCn: item.titleCn,
          actor: item.actor, actorF: item.actorF, actorM: item.actorM,
          status: item.status, tags: item.tags, note: item.note, magnet: item.magnet,
          series: item.series, director: item.director, platform: item.platform,
          release: item.release, maker: item.maker,
          downloaded: item.downloaded, saved: item.saved, ts: Date.now()
        });
        /* 图片：上传服务端 → 落 path */
        if(item.cover){
          var cn = item.cover.path || ('covers/' + (item.cover.name || coverNameOf(code)));
          var cd = map[cn] || (item.cover.name ? (map['covers/' + item.cover.name] || map[item.cover.name]) : null);
          if(cd) jobs.push(API.upload('covers', baseOf(cn), new Blob([cd])).then(function(r){
            row.cover = { name: baseOf(cn), path: r.path };
          }));
        }
        (item.shots || []).forEach(function(s, i){
          var sn = s.path || ('shots/' + (s.name || shotNameOf(code, i)));
          var sd = map[sn] || (s.name ? (map['shots/' + s.name] || map[s.name]) : null);
          if(sd) jobs.push(API.upload('shots', baseOf(sn), new Blob([sd])).then(function(r){
            row.shots.push({ name: baseOf(sn), path: r.path });
          }));
        });
        state.rows.push(row);
        added++;
      });
      if(!added && !jobs.length){ toast('没有可导入的新影片（跳过重复 ' + skipped + ' 条）', 'ok'); return; }
      API.backup('Film Library pre-zipimport ' + stamp() + '.json', payloadOf()).catch(function(){});
      /* v2.1.26 BUG-12（P1）：图片上传失败也必须落盘。
         旧版 Promise.all(jobs) 一失败就只 toast「导入完成但图片上传有问题」——既不
         commit 也不 saveData。但循环里 state.rows.push(row) 早已执行：内存有数据、
         磁盘没有，用户看到「导入完成」以为成功，刷新页面数据全没了，且备份与库不一致。
         改：逐任务 settle，无论成败都 commit+saveData，提示里给出失败图片数。 */
      var settleAll = Promise.all(jobs.map(function(p){
        return p.then(function(v){ return { ok: true, v: v }; }, function(err){ return { ok: false, e: err }; });
      }));
      settleAll.then(function(rs){
        var bad = rs.filter(function(r){ return !r.ok; }).length;
        commit(); saveData();
        var base = '新增 ' + added + ' 条' + (skipped ? '，跳过重复 ' + skipped + ' 条' : '');
        if(bad) toast('图片包导入完成（' + base + '），但有 ' + bad + ' 张图片上传失败，可稍后单条补图', 'warn');
        else toast('图片包导入完成：' + base, 'ok');
      });
    }).catch(function(e){ toast('导入失败：' + ((e && e.message) || e), 'err'); });
  };
  rd.readAsArrayBuffer(f);
}
function baseOf(p){ return String(p || '').split('/').pop(); }
