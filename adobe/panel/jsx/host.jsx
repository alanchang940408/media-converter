// Media Converter panel - host script (ExtendScript, ES3 only).
// Loaded by the CEP panel (manifest ScriptPath) in Premiere Pro and After Effects, and $.evalFile'd by
// adobe/tests/ae-render-test.jsx. Keep it ES3: no native JSON, no Array.prototype.indexOf/forEach, no trailing commas.
//
// Panel API (every call returns a JSON string):
//   MCHost.info()                 -> { ok, host, hostVersion, projectPath, items: [names], canWriteFiles }
//   MCHost.render(argsJson)       -> { ok, host, files: [abs paths], errors: [..], error?, message?, preset?, template? }
//        args: { outDir: <existing folder>, range?: 'entire'|'inout', eprPath?: <.epr> (Premiere), appDir?: <install dir> }
//   MCHost.findPreset(appDirJson) -> { ok, path, name }   (Premiere: the .epr used when the panel has none)
// The panel creates outDir with Node before calling render (After Effects scripts may not be allowed to write files).

var MCHost = (function () {
  var H = {};
  H.version = '0.1.0';

  // ---------------------------------------------------------------- JSON (stringify only; input comes from the panel)
  function quote(s) {
    var out = '"', i, c, code, hex;
    s = String(s);
    for (i = 0; i < s.length; i++) {
      c = s.charAt(i);
      code = s.charCodeAt(i);
      if (c === '"' || c === '\\') {
        out += '\\' + c;
      } else if (code < 0x20 || code > 0x7e) {
        // escape everything outside printable ASCII so CJK names survive the evalScript round trip
        hex = code.toString(16);
        while (hex.length < 4) hex = '0' + hex;
        out += '\\u' + hex;
      } else {
        out += c;
      }
    }
    return out + '"';
  }

  function stringify(v) {
    var t = typeof v, i, parts, k;
    if (v === null || v === undefined) return 'null';
    if (t === 'number') return isFinite(v) ? String(v) : 'null';
    if (t === 'boolean') return v ? 'true' : 'false';
    if (t === 'string') return quote(v);
    if (Object.prototype.toString.call(v) === '[object Array]') {
      parts = [];
      for (i = 0; i < v.length; i++) parts.push(stringify(v[i]));
      return '[' + parts.join(',') + ']';
    }
    if (t === 'object') {
      parts = [];
      for (k in v) {
        if (v.hasOwnProperty(k) && v[k] !== undefined && typeof v[k] !== 'function') parts.push(quote(k) + ':' + stringify(v[k]));
      }
      return '{' + parts.join(',') + '}';
    }
    return 'null';
  }

  function parse(s) {
    if (s === undefined || s === null || s === '') return {};
    if (typeof s !== 'string') return s;
    return eval('(' + s + ')');
  }

  H.stringify = stringify;
  H.parse = parse;

  // ---------------------------------------------------------------- helpers
  function hostName() {
    var n = '';
    try { n = BridgeTalk.appName; } catch (e) {}
    if (n === 'aftereffects') return 'aftereffects';
    if (n === 'premierepro') return 'premiere';
    return n || 'unknown';
  }
  H.hostName = hostName;

  function sep() { return $.os.indexOf('Windows') >= 0 ? '\\' : '/'; }

  function contains(arr, s) {
    var i;
    if (!arr) return false;
    for (i = 0; i < arr.length; i++) if (arr[i] === s) return true;
    return false;
  }

  // File-system safe base name (Windows rules are the strictest), max 120 chars.
  function safeName(name) {
    var s = String(name || '').replace(/[<>:"\/\\|?*\x00-\x1f]/g, '_');
    s = s.replace(/^\s+|[\s.]+$/g, '');
    if (s.length > 120) s = s.substring(0, 120);
    if (s === '' || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(s)) s = '_' + s;
    return s;
  }
  H.safeName = safeName;

  function uniqueName(base, used) {
    var n = base, i = 2;
    while (used[n.toLowerCase()]) { n = base + '_' + i; i++; }
    used[n.toLowerCase()] = true;
    return n;
  }

  function fail(code, message, extra) {
    var r = { ok: false, host: hostName(), files: [], errors: [code + (message ? ': ' + message : '')], error: code, message: message || '' };
    var k;
    if (extra) for (k in extra) if (extra.hasOwnProperty(k)) r[k] = extra[k];
    return r;
  }

  function errText(e) {
    var s = String(e);
    try { if (e && e.line) s += ' (line ' + e.line + ')'; } catch (x) {}
    return s;
  }

  function fileLength(path) {
    var f = new File(path);
    return f.exists ? f.length : -1;
  }

  // ---------------------------------------------------------------- After Effects
  // Output module templates, best first. The first one present in outputModule.templates is used.
  H.AE_TEMPLATES = ['Apple ProRes 422 HQ', 'High Quality', 'Lossless', 'Apple ProRes 4444', 'High Quality with Alpha', 'Lossless with Alpha'];

  H.aeCanWriteFiles = function () {
    var sections = ['Main Pref Section v2', 'Main Pref Section'], i, v;
    for (i = 0; i < sections.length; i++) {
      try {
        v = app.preferences.getPrefAsLong(sections[i], 'Pref_SCRIPTING_FILE_NETWORK_SECURITY');
        return v === 1;
      } catch (e) {}
    }
    return false;
  };

  H.aeTargetComps = function () {
    var out = [], sel, i, active;
    if (!app.project) return out;
    sel = app.project.selection;
    for (i = 0; i < sel.length; i++) if (sel[i] instanceof CompItem) out.push(sel[i]);
    if (!out.length) {
      active = app.project.activeItem;
      if (active && active instanceof CompItem) out.push(active);
    }
    return out;
  };

  function aeExtFromModule(om) {
    var f = null, m, fmt = '';
    try { f = om.file; } catch (e) {}
    if (f) {
      m = /\.([A-Za-z0-9]{2,5})$/.exec(f.fsName);
      if (m) return '.' + m[1].toLowerCase();
    }
    try { fmt = String(om.getSetting('Format')); } catch (e2) {}
    if (/quicktime/i.test(fmt)) return '.mov';
    if (/avi/i.test(fmt)) return '.avi';
    if (/h\.?264|mp4/i.test(fmt)) return '.mp4';
    return '.mov';
  }

  // Render the given CompItems through the render queue into outDir (an existing folder). Shared by the panel and
  // adobe/tests/ae-render-test.jsx. The user's own queued items are parked (render=false) and restored afterwards, and
  // the items added here are removed again, so the render queue looks the same as before.
  H.aeRenderComps = function (comps, outDir, opts) {
    var rq, dir, parked = [], plan = [], files = [], errors = [], used = {}, i, item, om, tpl, ext, base, p, f, status;
    opts = opts || {};
    if (!comps || !comps.length) return fail('noComps');
    rq = app.project.renderQueue;
    if (rq.rendering) return fail('busy');
    dir = new Folder(outDir);
    if (!dir.exists) return fail('noOutDir', outDir);

    for (i = 1; i <= rq.numItems; i++) {
      item = rq.item(i);
      if (item.status === RQItemStatus.QUEUED) parked.push(item);
    }
    try {
      for (i = 0; i < parked.length; i++) parked[i].render = false;

      for (i = 0; i < comps.length; i++) {
        item = rq.items.add(comps[i]);
        p = { item: item, comp: comps[i].name, path: '', template: '' };
        plan.push(p);
        if (contains(item.templates, 'Best Settings')) item.applyTemplate('Best Settings');
        om = item.outputModule(1);
        tpl = '';
        var prefs = opts.templates || H.AE_TEMPLATES, j;
        for (j = 0; j < prefs.length; j++) if (contains(om.templates, prefs[j])) { tpl = prefs[j]; break; }
        if (tpl) om.applyTemplate(tpl);
        p.template = tpl;
        ext = aeExtFromModule(om);
        base = uniqueName(safeName(comps[i].name), used);
        om.file = new File(dir.fsName + sep() + base + ext);
        p.path = om.file.fsName;
      }

      rq.render();

      for (i = 0; i < plan.length; i++) {
        p = plan[i];
        status = p.item.status;
        f = new File(p.path);
        if (status === RQItemStatus.DONE && f.exists && f.length > 0) files.push(f.fsName);
        else errors.push('renderFailed: ' + p.comp + ' (status ' + status + ', ' + (f.exists ? f.length + ' bytes' : 'no file') + ')');
      }
    } catch (e) {
      errors.push('exception: ' + errText(e));
    } finally {
      for (i = plan.length - 1; i >= 0; i--) {
        try { plan[i].item.remove(); } catch (e3) {}
      }
      for (i = 0; i < parked.length; i++) {
        try { parked[i].render = true; } catch (e4) {}
      }
    }
    return {
      ok: errors.length === 0 && files.length > 0,
      host: 'aftereffects',
      files: files,
      errors: errors,
      template: plan.length ? plan[0].template : ''
    };
  };

  // ---------------------------------------------------------------- Premiere Pro
  // High-quality presets shipped with Premiere Pro (MediaIO/systempresets/<format>/<name>.epr), best first.
  H.PPRO_PRESETS = [
    '3F3F3F3F_4D6F6F56/Apple ProRes 422 HQ.epr',
    '3F3F3F3F_4D6F6F56/GoPro CineForm YUV 10-bit.epr',
    '4E49434B_48323634/00 - Match Source - High bitrate.epr',
    '4E49434B_48323634/01 - Match Source - High bitrate.epr'
  ];

  function pproRoots(appDir) {
    var roots = [], c = [appDir], i, fo;
    try { c.push(Folder.appPackage ? Folder.appPackage.fsName : ''); } catch (e) {}
    try { c.push(app.path); } catch (e2) {}
    for (i = 0; i < c.length; i++) {
      if (!c[i]) continue;
      fo = new Folder(c[i]);
      // app.path may point at the executable
      if (!fo.exists) { fo = new File(c[i]).parent; }
      if (fo && fo.exists) roots.push(fo);
    }
    return roots;
  }

  H.pproFindPreset = function (appDir) {
    var roots = pproRoots(appDir), i, j, k, f, dir, subs, name;
    for (j = 0; j < H.PPRO_PRESETS.length; j++) {
      for (i = 0; i < roots.length; i++) {
        f = new File(roots[i].fsName + '/MediaIO/systempresets/' + H.PPRO_PRESETS[j]);
        if (f.exists) return f;
      }
    }
    // the format folder ids may differ between versions: look for the file names anywhere under systempresets
    for (i = 0; i < roots.length; i++) {
      dir = new Folder(roots[i].fsName + '/MediaIO/systempresets');
      if (!dir.exists) continue;
      subs = dir.getFiles(function (x) { return x instanceof Folder; });
      for (j = 0; j < H.PPRO_PRESETS.length; j++) {
        name = H.PPRO_PRESETS[j].split('/')[1];
        for (k = 0; k < subs.length; k++) {
          f = new File(subs[k].fsName + '/' + name);
          if (f.exists) return f;
        }
      }
    }
    return null;
  };

  H.pproRender = function (args) {
    var seq, epr, ext = '', dir, out, range, enc, rv, len;
    if (!app.project) return fail('noProject');
    seq = app.project.activeSequence;
    if (!seq) return fail('noSequence');
    dir = new Folder(args.outDir);
    if (!dir.exists) return fail('noOutDir', args.outDir);
    epr = args.eprPath ? new File(args.eprPath) : null;
    if (!epr || !epr.exists) epr = H.pproFindPreset(args.appDir);
    if (!epr) return fail('noPreset');

    try { ext = seq.getExportFileExtension(epr.fsName); } catch (e) {}
    ext = ext ? String(ext) : 'mov';
    if (ext.charAt(0) !== '.') ext = '.' + ext;
    out = new File(dir.fsName + sep() + safeName(seq.name) + ext);

    enc = null;
    try { enc = app.encoder; } catch (e2) {}
    range = 0; // ENCODE_ENTIRE
    if (args.range === 'inout') range = (enc && enc.ENCODE_IN_TO_OUT !== undefined) ? enc.ENCODE_IN_TO_OUT : 1;
    else if (enc && enc.ENCODE_ENTIRE !== undefined) range = enc.ENCODE_ENTIRE;

    try {
      rv = seq.exportAsMediaDirect(out.fsName, epr.fsName, range);
    } catch (e3) {
      return fail('exportFailed', errText(e3), { preset: epr.fsName });
    }
    len = fileLength(out.fsName);
    if (len <= 0) return fail('exportFailed', String(rv === undefined ? '' : rv), { preset: epr.fsName });
    return { ok: true, host: 'premiere', files: [out.fsName], errors: [], preset: epr.fsName };
  };

  // ---------------------------------------------------------------- panel API
  H.info = function () {
    var host = hostName(), r = { ok: true, host: host, hostVersion: '', projectPath: '', items: [], canWriteFiles: true }, comps, i, seq;
    try {
      r.hostVersion = String(app.version);
      if (host === 'aftereffects') {
        r.projectPath = app.project && app.project.file ? app.project.file.fsName : '';
        comps = H.aeTargetComps();
        for (i = 0; i < comps.length; i++) r.items.push(comps[i].name);
        r.canWriteFiles = H.aeCanWriteFiles();
      } else if (host === 'premiere') {
        r.projectPath = app.project ? String(app.project.path || '') : '';
        seq = app.project ? app.project.activeSequence : null;
        if (seq) r.items.push(seq.name);
      }
    } catch (e) {
      r.ok = false;
      r.message = errText(e);
    }
    return stringify(r);
  };

  H.findPreset = function (argsJson) {
    var args = parse(argsJson), f;
    try {
      f = H.pproFindPreset(args.appDir);
    } catch (e) {
      return stringify(fail('exception', errText(e)));
    }
    if (!f) return stringify({ ok: false, path: '', name: '' });
    return stringify({ ok: true, path: f.fsName, name: decodeURI(f.name).replace(/\.epr$/i, '') });
  };

  H.render = function (argsJson) {
    var args, host = hostName(), r;
    try {
      args = parse(argsJson);
      if (host === 'aftereffects') r = H.aeRenderComps(H.aeTargetComps(), args.outDir, args);
      else if (host === 'premiere') r = H.pproRender(args);
      else r = fail('unsupportedHost', host);
    } catch (e) {
      r = fail('exception', errText(e));
    }
    return stringify(r);
  };

  return H;
}());
