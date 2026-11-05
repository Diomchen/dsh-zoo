<!--
粘贴用：下面是英文正文，可直接开 issue（建议开在 rename-overwrite，再给 pnpm 提一个依赖升级）。

本文件相对你手写那版改了三处：
1. `EACCESS` 是上游拼写错误（应为 `EACCES`），那条 case 从来没生效过——顺手报上去。
2. 「Field report」按本机复核后的真实机制改写：不是"helper 把包目录 keep loaded"，
   而是 helper 的**工作目录**落在包内。Windows 删不掉进程的 cwd，这比"文件被占用"更常见，
   也更容易在 pnpm 自己的测试里复现。
3. 补了两条论据：忙等是热循环（60s 吃满一个核）；EPERM 分支即使**成功**也有一个窗口
   期间包不存在，那时崩溃/断电就只剩一个空目录。
-->

# `renameOverwriteSync` deletes the destination before retrying: a failed re-import destroys the installed package

## Environment

| item | value |
| --- | --- |
| pnpm | 11.28.5 (bundled; invoked as `node pnpm.mjs`) |
| vendored `rename-overwrite` | 7.0.1 (`dist/worker.js:11474`) |
| Node | 24.21.0 |
| OS | Windows 11, 10.0.26200.9711 |
| linker | `nodeLinker: hoisted` (`pnpm-workspace.yaml`) |
| package source | local `file:` tarball |

## Summary

`renameOverwriteSync` treats `EPERM` as "the target is in the way, delete it", then retries the
rename in a 60 s loop. On Windows, `rename()` always fails with `EPERM` when the destination is an
existing (non-empty) directory, so this branch runs on every routine "replace an installed package"
import. If the target cannot actually be replaced — a process holding a handle inside it, or simply
having it as its current working directory, antivirus, a running helper — the old package has already
been partially deleted by the time the error surfaces, and the freshly-imported copy in the staging
directory is deleted as well. Net result: the package is destroyed, not restored.

## Expected vs Actual

Expected: a failed install leaves the previously installed copy untouched (`EPERM` ⇒ "target busy",
not "target removable").

Actual: the previously installed copy is partially deleted, the staged copy is removed, and pnpm exits
with `ERR_PNPM_EPERM` after ~2 minutes. The dependency is then in a hybrid state (old `package.json`,
missing files) while the lockfile points at the new version.

## Minimal reproduction

```bash
# fixtures: two versions of a trivial package
R=/tmp/pnpm-repro; rm -rf $R; mkdir -p $R/pkg/v1/package/d $R/pkg/v2/package/d $R/proj
echo '{"name":"demo-pkg","version":"1.0.0","files":["a.txt","d"]}' > $R/pkg/v1/package/package.json
echo v1 > $R/pkg/v1/package/a.txt;  echo b1 > $R/pkg/v1/package/d/b.txt
echo '{"name":"demo-pkg","version":"2.0.0","files":["a.txt","d"]}' > $R/pkg/v2/package/package.json
echo v2 > $R/pkg/v2/package/a.txt;  echo b2 > $R/pkg/v2/package/d/b.txt
tar -czf $R/demo-pkg-1.0.0.tgz -C $R/pkg/v1 package
tar -czf $R/demo-pkg-2.0.0.tgz -C $R/pkg/v2 package
echo '{"name":"proj","private":true,"dependencies":{"demo-pkg":"file:../demo-pkg-1.0.0.tgz"}}' > $R/proj/package.json
printf 'packages:\n  - .\nautoInstallPeers: false\nnodeLinker: hoisted\n' > $R/proj/pnpm-workspace.yaml

cd $R/proj && pnpm install          # -> demo-pkg 1.0.0
```

Hold the installed package busy. Two ways, both observed in the field; the second is the more common one
because it needs no file handle at all:

```powershell
# (a) an open file handle without FILE_SHARE_DELETE
$f = [IO.File]::Open("$R\proj\node_modules\demo-pkg\d\b.txt", 'Open', 'Read', 'None')
Start-Sleep -Seconds 900
```

```powershell
# (b) a live process whose CWD is inside the package — Windows cannot delete a process's CWD
$p = Start-Process powershell -ArgumentList '-NoExit','-Command','cd "$R\proj\node_modules\demo-pkg\desktop"'
```

Then bump the dependency and reinstall:

```bash
echo '{"name":"proj","private":true,"dependencies":{"demo-pkg":"file:../demo-pkg-2.0.0.tgz"}}' > $R/proj/package.json
cd $R/proj && pnpm install
```

Observed (verbatim):

```
=== before ===
node_modules/demo-pkg/a.txt
node_modules/demo-pkg/d/b.txt
node_modules/demo-pkg/package.json
[ERR_PNPM_EPERM] [importPackage ...\node_modules\demo-pkg] EPERM: operation not permitted,
  rename '...\node_modules\demo-pkg_tmp_43748_1' -> '...\node_modules\demo-pkg'

real    2m3.591s

=== after ===
node_modules/demo-pkg
node_modules/demo-pkg/d
node_modules/demo-pkg/d/b.txt
node_modules/demo-pkg/package.json     <- still 1.0.0
```

`a.txt` is gone; `package.json` still declares 1.0.0; the staging directory `demo-pkg_tmp_*` is gone too.

## Root cause

`dist/worker.js` (pnpm 11.28.5 bundle), vendored `rename-overwrite@7.0.1`:

```js
// worker.js:11474
function renameOverwriteSync (oldPath, newPath, retry = 0) {
  try {
    fs4.renameSync(oldPath, newPath)
  } catch (err) {
    retry++
    if (retry > 3) throw err
    switch (err.code) {
      // Windows Antivirus issues
      case 'EPERM':
      case 'EACCESS':      // <-- typo: should be 'EACCES'; this case can never match
      case 'EBUSY': {
        try {
          rimrafSync(newPath)          // <-- the destination (old version) is deleted
        } catch {}
        const start = Date.now()
        ...
        while (Date.now() - start < 6e4 && (lastError.code === 'EPERM' || ...)) {
          try { fs4.renameSync(oldPath, newPath); return }   // 60s busy-wait retry
          catch (err2) { lastError = err2 }
          ...
        }
        throw lastError                // <-- the old version is already gone
      }
```

Two more notes on that branch:

- The retry loop spins on `Date.now()` with a backoff that never sleeps — for up to 60 s it burns a whole
  core while the package directory is in a half-deleted state.
- Even when the retry **succeeds**, there is a window in which the package does not exist at all. A crash
  or power loss in that window leaves a missing dependency rather than the previous version.

and the importer throws away the new copy on the same path:

```js
// worker.js:16923 (commitStagedDir)
function commitStagedDir (stage, newDir) {
  try {
    withFileLockRetry(() => { renameOverwriteSync(stage, newDir) })
  } catch (renameErr) {
    cleanStageDir(stage)      // <-- the new version is deleted as well
    throw renameErr
  }
}
```

So the failure mode is: delete old → fail to place new → delete new.

## Why this is the normal path on Windows, not an edge case

`MoveFileEx` cannot replace an existing directory, and Node surfaces that as `EPERM` for
directory-to-directory renames. pnpm's own logs from the field incident show exactly `EPERM`
(never `EEXIST`/`ENOTEMPTY`), i.e. every replacement of an installed package on Windows goes
through the `rimraf` branch. The "delete first" is therefore not a fallback for a weird
antivirus case — it is what happens on every successful upgrade too, just with a narrower window
where the package does not exist at all.

## Proposed fix

`swapRenameSync` — the non-destructive implementation — is already in the same file:

```js
// worker.js:11542
function swapRenameSync (oldPath, newPath) {
  const temp = tempPath(newPath)
  fs4.renameSync(newPath, temp)          // move the old dir aside; throws before deleting anything
  try {
    fs4.renameSync(oldPath, newPath)     // put the new dir in place
  } catch (err) {
    try { fs4.renameSync(temp, newPath) } catch {}   // roll back
    throw err
  }
  try { rimrafSync(temp) } catch {}
}
```

Minimal, non-destructive change (in `rename-overwrite/index.js`; pnpm would then need a dependency bump):

```diff
       case "EPERM":
       case "EACCESS":
       case "EBUSY": {
-        try {
-          rimrafSync(newPath);
-        } catch {
-        }
+        // The destination is busy (on Windows this also covers "replace an existing
+        // directory"). Never delete it first: if the swap fails, the old copy must survive.
+        try {
+          swapRenameSync(oldPath, newPath);
+          return;
+        } catch {
+          // genuinely locked: fall through to the backoff retry, and throw without
+          // touching the destination if it still cannot be replaced
+        }
         const start = Date.now();
         ...
       case "ENOTEMPTY":
       case "EEXIST":
       case "ENOTDIR":
         try {
           swapRenameSync(oldPath, newPath);
         } catch {
-          rimrafSync(newPath);
-          fs4.renameSync(oldPath, newPath);
+          throw new Error(`cannot replace ${newPath}: it is in use`);
         }
         break;
```

Optional, in pnpm's `commitStagedDir`: on a failed commit, keep the staging directory
(`<newDir>.incoming-<pid>`) instead of `cleanStageDir(stage)`, so the imported copy is recoverable
and a subsequent retry can reuse it.

## Field report (real-world occurrence)

App: DeepSeek Harness desktop (Electron), profile dir `C:\Users\sean\.dsh\profiles\desktop`,
`nodeLinker: hoisted`. A plugin (`dsh-zoo`) is installed from a local tarball; its Electron helper
is spawned with `cwd` set to `<pkg>\desktop` — a live process whose working directory is inside the
installed package (this is the common shape: any tool started from a directory inside `node_modules`).

A second plugin install (`dsh-ops`) triggered a full-tree reconcile; pnpm decided `dsh-zoo` had to be
re-imported.

The re-import hit the `EPERM` branch: `rimraf` emptied `node_modules\dsh-zoo\desktop\` and deleted
`cordis.patch.yml`, then failed to remove the `desktop` directory itself (it was the helper's CWD), so it
aborted; `src\`, `index.js`, `package.json` survived.

pnpm logged `ERR_PNPM_EPERM` after 126 s (matches the 60 s loop), removed the staging directory, and
reported `MUTATION_FAILED`.

Because `cordis.patch.yml` is the plugin's declared bundle entry (`dsh.bundle.patch`), the host app could no
longer mount the plugin on the next start: no routes registered, no helper process. The user saw the plugin
silently disappear with no error in the UI.

The package was 51 files before the incident, 36 after; the difference is exactly `cordis.patch.yml` + the
14 files under `desktop\`.

(The plugin side moved its helper's CWD out of the package, so this particular trigger is gone — but the
failure mode above is not specific to that plugin: any process with a CWD or an open handle inside an
installed directory reproduces it.)

## Secondary suggestions

- `ERR_PNPM_EPERM` on Windows could suggest the likely cause ("a process is using this package; close it
  and retry") instead of only printing the rename error.
- `--force` / reinstall paths go through the same code and carry the same risk.
- `case 'EACCESS'` should be `'EACCES'`; as written, the `EACCES` errno bypasses every retry path and throws
  immediately.
