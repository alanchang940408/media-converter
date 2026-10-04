// After Effects render test (ExtendScript, ES3) - run by scripts/test-ae.mjs through a generated launcher:
//   AfterFX.exe -r <temp>/run-ae-test.jsx   (sets MC_AE_TEST, then $.evalFile's this file)
// AfterFX.exe -r silently ignores a script path that contains a space, so the launcher lives in a space-free temp folder
// and this file (inside the repo, any path) is loaded from it.
// Builds a throwaway project (1920x1080, 3 s comp with a solid and a text layer), renders it with the SAME function the
// panel uses (MCHost.aeRenderComps from adobe/panel/jsx/host.jsx) into a temporary bridge/intermediates/<id>/ folder,
// then closes the project without saving and quits After Effects.
//
// Inputs: global MC_AE_TEST = { hostJsx, outDir, report, pproDir } from the launcher, else the environment
// (MC_AE_TEST_HOST_JSX / MC_AE_TEST_OUT_DIR / MC_AE_TEST_REPORT / MC_AE_TEST_PPRO_DIR):
//   hostJsx  absolute path of adobe/panel/jsx/host.jsx
//   outDir   existing folder to render into (temp bridge/intermediates/<id>)
//   report   where to write a JSON report (scripts started with -r could write files here even with "Allow Scripts to
//            Write Files and Access Network" off; the test never changes that preference)
//   pproDir  optional Premiere Pro install folder: also checks MCHost.pproFindPreset against it (File/Folder only)
(function () {
  var report = { ok: false, aeVersion: '', canWriteFiles: false, steps: [], render: null, omTemplates: [], pproPreset: null, error: '' };
  var cfg = (typeof MC_AE_TEST !== 'undefined' && MC_AE_TEST) ? MC_AE_TEST : {};
  var hostJsx = cfg.hostJsx || $.getenv('MC_AE_TEST_HOST_JSX');
  var outDir = cfg.outDir || $.getenv('MC_AE_TEST_OUT_DIR');
  var reportPath = cfg.report || $.getenv('MC_AE_TEST_REPORT');
  var pproDir = cfg.pproDir || $.getenv('MC_AE_TEST_PPRO_DIR');

  function step(s) { report.steps.push(s); }
  function quoteAscii(s) {
    return '"' + String(s).replace(/[\\"]/g, '\\$&').replace(/[^ -~]/g, '?') + '"';
  }
  function toFsPath(p) { return String(p).replace(/\\/g, '/'); }

  try { report.aeVersion = String(app.version); } catch (e0) {}
  try { app.beginSuppressDialogs(); } catch (e1) {}

  try {
    if (!hostJsx || !outDir) throw new Error('MC_AE_TEST_HOST_JSX / MC_AE_TEST_OUT_DIR not set');
    $.evalFile(new File(toFsPath(hostJsx)));
    step('host.jsx loaded');
    report.canWriteFiles = MCHost.aeCanWriteFiles();

    app.newProject();
    step('new project');

    var comp = app.project.items.addComp('MC Bridge Test', 1920, 1080, 1, 3, 30);
    comp.layers.addSolid([0.12, 0.35, 0.75], 'Background', 1920, 1080, 1, 3);
    var textLayer = comp.layers.addText('Media Converter - AE bridge test');
    var srcText = textLayer.property('ADBE Text Properties').property('ADBE Text Document');
    var doc = srcText.value;
    doc.fontSize = 96;
    doc.applyFill = true; // fillColor can only be set when applyFill is on
    doc.fillColor = [1, 1, 1];
    doc.justification = ParagraphJustification.CENTER_JUSTIFY;
    srcText.setValue(doc);
    textLayer.property('ADBE Transform Group').property('ADBE Position').setValue([960, 560]);
    step('comp built');

    // which output module templates this After Effects offers (the panel takes the first of MCHost.AE_TEMPLATES)
    try {
      var probe = app.project.renderQueue.items.add(comp);
      report.omTemplates = probe.outputModule(1).templates;
      probe.remove();
    } catch (eT) {}

    var r = MCHost.aeRenderComps([comp], toFsPath(outDir), {});
    report.render = r;
    report.ok = r.ok;
    step('render returned');

    if (pproDir) {
      var epr = MCHost.pproFindPreset(toFsPath(pproDir));
      report.pproPreset = epr ? epr.fsName : '';
      step('premiere preset lookup');
    }
  } catch (e) {
    report.error = String(e) + (e && e.line ? ' (line ' + e.line + ')' : '');
  }

  if (reportPath) {
    try {
      var f = new File(toFsPath(reportPath));
      f.encoding = 'UTF-8';
      if (f.open('w')) {
        // MCHost.stringify when host.jsx loaded; otherwise a minimal JSON so the failure is still reported
        f.write(typeof MCHost !== 'undefined' ? MCHost.stringify(report)
          : '{"ok":false,"steps":[],"render":null,"error":' + quoteAscii(report.error) + '}');
        f.close();
      }
    } catch (e2) {}
  }

  try { app.project.close(CloseOptions.DO_NOT_SAVE_CHANGES); } catch (e3) {}
  try { app.endSuppressDialogs(false); } catch (e4) {}
  app.quit();
}());
