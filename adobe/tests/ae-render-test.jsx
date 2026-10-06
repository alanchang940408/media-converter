// After Effects side of the background-render test (ExtendScript, ES3) - run by scripts/test-ae.mjs through a generated
// launcher:
//   AfterFX.exe -r <temp>/run-ae-test.jsx   (sets MC_AE_TEST, then $.evalFile's this file)
// AfterFX.exe -r silently ignores a script path that contains a space, so the launcher lives in a space-free temp folder
// and this file (inside the repo, any path) is loaded from it.
// Builds a throwaway project (1920x1080 3 s comps "MC Bridge Test" and one whose name has a space + CJK, a solid and a
// text layer each) and checks the panel's own planning function (MCHost.planBackground from adobe/panel/jsx/host.jsx):
//   1. unsaved project              -> error unsavedProject
//   2. project saved to cfg.projectPath (a folder with a space and CJK); another comp named like the selected one
//                                   -> error duplicateComp (the extra comp is removed again)
//   3. both comps selected          -> the plan (the project is saved again by planBackground)
// then writes the report and LEAVES After Effects OPEN with the saved project: test-ae.mjs renders the plan with
// aerender (js/aerender.cjs) meanwhile, exactly as the panel does, and quits After Effects afterwards through a second
// AfterFX.exe -r script.
//
// Inputs: global MC_AE_TEST = { hostJsx, projectPath, report, pproDir } from the launcher, else the environment
// (MC_AE_TEST_HOST_JSX / MC_AE_TEST_PROJECT / MC_AE_TEST_REPORT / MC_AE_TEST_PPRO_DIR):
//   hostJsx      absolute path of adobe/panel/jsx/host.jsx
//   projectPath  where to save the project (.aep; its folder exists)
//   report       where to write the JSON report (scripts started with -r could write files here even with "Allow
//                Scripts to Write Files and Access Network" off; the test never changes that preference); "done": true
//                marks it complete
//   pproDir      optional Premiere Pro install folder: also checks MCHost.pproFindPreset against it (File/Folder only)
// Keep this file ASCII (non-ASCII text as \u escapes): ExtendScript may read a script without BOM in the system code
// page.
(function () {
  var report = {
    ok: false, done: false, aeVersion: '', hostVersion: '', canWriteFiles: false, steps: [], omTemplates: [],
    unsaved: null, duplicate: null, plan: null, savedAs: '', pproPreset: null, error: ''
  };
  var cfg = (typeof MC_AE_TEST !== 'undefined' && MC_AE_TEST) ? MC_AE_TEST : {};
  var hostJsx = cfg.hostJsx || $.getenv('MC_AE_TEST_HOST_JSX');
  var projectPath = cfg.projectPath || $.getenv('MC_AE_TEST_PROJECT');
  var reportPath = cfg.report || $.getenv('MC_AE_TEST_REPORT');
  var pproDir = cfg.pproDir || $.getenv('MC_AE_TEST_PPRO_DIR');
  var COMP2 = '\u6e2c\u8a66 \u5408\u6210'; // "test comp" in Traditional Chinese, with a space

  function step(s) { report.steps.push(s); }
  function quoteAscii(s) {
    return '"' + String(s).replace(/[\\"]/g, '\\$&').replace(/[^ -~]/g, '?') + '"';
  }
  function toFsPath(p) { return String(p).replace(/\\/g, '/'); }

  function buildComp(name, label, color) {
    var comp = app.project.items.addComp(name, 1920, 1080, 1, 3, 30);
    comp.layers.addSolid(color, 'Background', 1920, 1080, 1, 3);
    var textLayer = comp.layers.addText(label);
    var srcText = textLayer.property('ADBE Text Properties').property('ADBE Text Document');
    var doc = srcText.value;
    doc.fontSize = 96;
    doc.applyFill = true; // fillColor can only be set when applyFill is on
    doc.fillColor = [1, 1, 1];
    doc.justification = ParagraphJustification.CENTER_JUSTIFY;
    srcText.setValue(doc);
    textLayer.property('ADBE Transform Group').property('ADBE Position').setValue([960, 560]);
    return comp;
  }

  // Select exactly these items in the Project panel (MCHost.aeTargetComps reads app.project.selection).
  function selectOnly(items) {
    var i, j, it, on;
    for (i = 1; i <= app.project.numItems; i++) {
      it = app.project.item(i);
      on = false;
      for (j = 0; j < items.length; j++) if (items[j] === it) on = true;
      it.selected = on;
    }
  }

  function plan() {
    return MCHost.parse(MCHost.planBackground('{}'));
  }

  try { report.aeVersion = String(app.version); } catch (e0) {}
  try { app.beginSuppressDialogs(); } catch (e1) {}

  try {
    if (!hostJsx || !projectPath) throw new Error('MC_AE_TEST_HOST_JSX / MC_AE_TEST_PROJECT not set');
    $.evalFile(new File(toFsPath(hostJsx)));
    step('host.jsx loaded');
    report.hostVersion = MCHost.version;
    report.canWriteFiles = MCHost.aeCanWriteFiles();

    app.newProject();
    step('new project');
    var comp1 = buildComp('MC Bridge Test', 'Media Converter - AE bridge test', [0.12, 0.35, 0.75]);
    var comp2 = buildComp(COMP2, 'Media Converter - comp 2', [0.65, 0.22, 0.2]);
    step('comps built');

    // which output module templates this After Effects offers (planBackground takes the first of MCHost.AE_TEMPLATES)
    try {
      var probe = app.project.renderQueue.items.add(comp1);
      report.omTemplates = probe.outputModule(1).templates;
      probe.remove();
    } catch (eT) {}

    // 1. never saved
    selectOnly([comp1, comp2]);
    report.unsaved = plan();
    step('plan (unsaved)');

    // 2. saved; then a second comp with the same name as the selected one
    app.project.save(new File(toFsPath(projectPath)));
    report.savedAs = app.project.file ? app.project.file.fsName : '';
    step('project saved');
    var dup = app.project.items.addComp('MC Bridge Test', 640, 360, 1, 1, 30);
    selectOnly([comp1]);
    report.duplicate = plan();
    dup.remove();
    step('plan (duplicate name)');

    // 3. the real plan: both comps
    selectOnly([comp1, comp2]);
    report.plan = plan();
    report.ok = !!(report.plan && report.plan.ok);
    step('plan');

    if (pproDir) {
      var epr = MCHost.pproFindPreset(toFsPath(pproDir));
      report.pproPreset = epr ? epr.fsName : '';
      step('premiere preset lookup');
    }
  } catch (e) {
    report.error = String(e) + (e && e.line ? ' (line ' + e.line + ')' : '');
  }
  report.done = true;

  if (reportPath) {
    try {
      var f = new File(toFsPath(reportPath));
      f.encoding = 'UTF-8';
      if (f.open('w')) {
        // MCHost.stringify when host.jsx loaded; otherwise a minimal JSON so the failure is still reported
        f.write(typeof MCHost !== 'undefined' ? MCHost.stringify(report)
          : '{"ok":false,"done":true,"steps":[],"plan":null,"error":' + quoteAscii(report.error) + '}');
        f.close();
      }
    } catch (e2) {}
  }

  try { app.endSuppressDialogs(false); } catch (e4) {}
  // After Effects stays open (the project saved, the comps in it): see the header
}());
