// Media Converter panel - host script (ExtendScript, ES3 only).
// Loaded by the CEP panel (manifest ScriptPath) in Premiere Pro and After Effects, and $.evalFile'd by
// adobe/tests/ae-render-test.jsx. Keep it ES3: no native JSON, no Array.prototype.indexOf/forEach, no trailing commas.
//
// Panel API (every call returns a JSON string):
//   MCHost.info()                 -> { ok, host, hostVersion, projectPath, items: [names], canWriteFiles }
//   MCHost.render(argsJson)       -> { ok, host, files: [abs paths], errors: [..], error?, message?, preset? }   (Premiere)
//        args: { outDir: <existing folder>, range?: 'entire'|'inout', eprPath?: <.epr>, appDir?: <install dir> }
//   MCHost.findPreset(appDirJson) -> { ok, path, name }   (Premiere: the .epr used when the panel has none)
//   MCHost.planBackground(argsJson) (After Effects) -> what aerender.exe (js/aerender.cjs) renders in the background:
//        args: { templates?: [output module template names, best first] }   (default MCHost.AE_TEMPLATES)
//        ok:   { ok: true, host, projectPath, aerenderPath,
//                items: [{ comp, frames, fps, omTemplate, ext: '.mov', baseName }] }
//        fail: { ok: false, host, error: 'unsavedProject'|'noComps'|'duplicateComp'|'compQueued'|'saveFailed'|'noAerender'|
//                'busy'|'exception', message, errors }
//        The project is saved (aerender renders the saved file, as After Effects -> Media Encoder does).
//        compQueued (message = the comp name): the comp is queued in the Render Queue, and aerender -comp would render
//        that item (its settings and output modules) instead of adding its own.
// The panel creates outDir with Node before calling render (host scripts may not be allowed to write files).

var MCHost = (function () {
  var H = {};
  H.version = '0.2.0';

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

  // Output module template for the intermediate: the first of prefs this After Effects has, else (localized template
  // names) the first template that writes QuickTime (.mov), else '' = the module's default (re-applied when known).
  function aePickTemplate(om, prefs) {
    var list = om.templates, i, name, original = '';
    for (i = 0; i < prefs.length; i++) if (contains(list, prefs[i])) return prefs[i];
    try { original = String(om.name); } catch (e) {}
    for (i = 0; i < list.length; i++) {
      name = list[i];
      if (/^_HIDDEN/i.test(name)) continue;
      try { om.applyTemplate(name); } catch (e2) { continue; }
      if (aeExtFromModule(om) === '.mov') return name;
    }
    if (original && contains(list, original)) {
      try { om.applyTemplate(original); } catch (e3) {}
    }
    return '';
  }

  // aerender.exe next to the After Effects executable (Windows: Support Files\aerender.exe; macOS: next to the .app).
  function aeRenderBinary() {
    var dirs = [], i, f;
    try { if (Folder.appPackage) dirs.push(Folder.appPackage); } catch (e) {}
    try { if (Folder.startup) dirs.push(Folder.startup); } catch (e2) {}
    for (i = 0; i < dirs.length; i++) {
      if ($.os.indexOf('Windows') >= 0) {
        f = new File(dirs[i].fsName + '/aerender.exe');
      } else {
        f = new File((dirs[i].parent ? dirs[i].parent.fsName : dirs[i].fsName) + '/aerender');
      }
      if (f.exists) return f;
    }
    return null;
  }

  // CompItems of the whole project with this name (aerender -comp picks a comp by name).
  function aeCompsNamed(name) {
    var n = 0, i, it;
    for (i = 1; i <= app.project.numItems; i++) {
      it = app.project.item(i);
      if (it instanceof CompItem && it.name === name) n++;
    }
    return n;
  }

  // Name of the first target comp that has a queueable item in the Render Queue (status Queued or Unqueued), '' = none.
  // aerender -comp renders the first queueable item of a comp that is already in the queue (with that item's render
  // settings and output modules, to its paths) instead of adding its own; comps are matched by name, like aerender.
  function aeQueuedComp(rq, comps) {
    var i, j, it, st, name, n = 0;
    if (typeof RQItemStatus === 'undefined') return '';
    try { n = rq.numItems; } catch (e) { return ''; }
    for (i = 1; i <= n; i++) {
      try {
        it = rq.item(i);
        st = it.status;
        if (st !== RQItemStatus.QUEUED && st !== RQItemStatus.UNQUEUED) continue;
        name = it.comp.name;
      } catch (e2) { continue; }
      for (j = 0; j < comps.length; j++) if (comps[j].name === name) return name;
    }
    return '';
  }

  // Plan a background render with aerender.exe: for each target comp a temporary render queue item gets
  // 'Best Settings' + the first available output module template, frames / ext are read from it and the item is
  // removed again; then the project is saved, since aerender renders the saved file.
  H.planBackground = function (argsJson) {
    var args, host = hostName(), rq, comps, aer, prefs, added = [], items = [], used = {}, i, comp, item, om, tpl, frames, queued;
    function planFail(code, message) {
      var r = fail(code, message);
      delete r.files;
      return stringify(r);
    }
    try {
      args = parse(argsJson);
      if (host !== 'aftereffects') return planFail('exception', 'unsupportedHost: ' + host);
      if (!app.project) return planFail('noComps');
      rq = app.project.renderQueue;
      if (rq.rendering) return planFail('busy');
      if (!app.project.file) return planFail('unsavedProject');
      aer = aeRenderBinary();
      if (!aer) {
        var where = '';
        try { where = new File(Folder.appPackage.fsName + '/aerender.exe').fsName; } catch (e0) {}
        return planFail('noAerender', where);
      }
      comps = H.aeTargetComps();
      if (!comps.length) return planFail('noComps');
      for (i = 0; i < comps.length; i++) {
        if (aeCompsNamed(comps[i].name) > 1) return planFail('duplicateComp', comps[i].name);
      }
      // before the temporary items below are added (they are queued too)
      queued = aeQueuedComp(rq, comps);
      if (queued) return planFail('compQueued', queued);
      prefs = (args.templates && args.templates.length) ? args.templates : H.AE_TEMPLATES;

      try {
        for (i = 0; i < comps.length; i++) {
          comp = comps[i];
          item = rq.items.add(comp);
          added.push(item);
          if (contains(item.templates, 'Best Settings')) item.applyTemplate('Best Settings');
          om = item.outputModule(1);
          tpl = aePickTemplate(om, prefs);
          if (tpl) om.applyTemplate(tpl);
          frames = Math.round(item.timeSpanDuration / comp.frameDuration);
          items.push({
            comp: comp.name,
            frames: frames >= 1 ? frames : 1,
            fps: comp.frameRate,
            omTemplate: tpl,
            ext: aeExtFromModule(om),
            baseName: uniqueName(safeName(comp.name), used)
          });
        }
      } finally {
        for (i = added.length - 1; i >= 0; i--) {
          try { added[i].remove(); } catch (e3) {}
        }
      }

      try {
        app.project.save();
      } catch (e4) {
        return planFail('saveFailed', errText(e4));
      }
      return stringify({
        ok: true,
        host: 'aftereffects',
        projectPath: app.project.file.fsName,
        aerenderPath: aer.fsName,
        items: items
      });
    } catch (e) {
      return planFail('exception', errText(e));
    }
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
      // After Effects renders in the background with aerender (planBackground + js/aerender.cjs)
      if (host === 'premiere') r = H.pproRender(args);
      else r = fail('unsupportedHost', host);
    } catch (e) {
      r = fail('exception', errText(e));
    }
    return stringify(r);
  };

  return H;
}());
