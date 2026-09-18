# Paseo File Transfer

An independent **File Transfer** workspace panel for **Paseo 0.8.0 / 0.8.x**. Files reside on the daemon host that owns the current workspace; uploads originate from, and downloads are saved to, the desktop app or browser you are using.

This plugin lives in the [`file-upload/`](.) directory of the [`lalaze/paseo-plugins`](https://github.com/lalaze/paseo-plugins) multi-plugin repository. You do not need to reinstall it when switching computers that connect to the same Paseo daemon.

## Features

- Browse the workspace in an expandable directory tree that loads subdirectories on demand and shows the actual path at the top.
- Drag one or more files from Finder or a file manager. Drop them on a folder row to upload there, or on a file row to upload to its containing folder; the destination row is highlighted.
- Click **Upload Files** to choose files, or click **Download** on a file row to save it locally.
- Chunked transfers, progress, cancellation, and per-file results for multiple uploads. Duplicate names produce an error and are never overwritten automatically.
- Files are published atomically after upload; canceled or expired sessions clean up temporary files.
- RPC traffic uses the existing Paseo connection, with no additional service or port.

This is a standalone panel and does not modify Paseo's built-in **Files** or **Changes** lists. Native drag-out to Finder is not currently available, so downloads use a button.

Open a workspace, press **⌘K** (**Ctrl+K** on Windows or Linux), and search for **File Transfer: Upload and Download**. It opens in the right-hand Explorer panel by default. You can also add **File Transfer** from the Explorer panel settings. Because the plugin is hosted only in the right-hand Explorer, it does not appear in the **+** menu of the center tab bar.

## Installation

Install the plugin separately on each daemon. Both daemon and client must be **0.8.x**. The plugin ID is `paseo-file-upload`.

Enable plugins under Paseo **Settings → Plugins** on the target host. Make sure Git and npm are installed and that the daemon user has GitHub SSH read access to this repository, then run on that host:

```bash
paseo plugin add lalaze/paseo-plugins --path file-upload
paseo plugin ls paseo-file-upload --json
```

SSH source:

```bash
paseo plugin install git@github.com:lalaze/paseo-plugins.git:file-upload --ref main
```

`--path file-upload` or `:file-upload` selects the plugin subdirectory in this multi-plugin repository. Installation automatically runs `npm ci --include=dev --ignore-scripts` with locked dependencies and a type check before Paseo compiles and loads the plugin.

After the status becomes `running`, open a workspace, press **⌘K**, and search for **File Transfer: Upload and Download**.

## Updating

For a GitHub-source installation:

```bash
paseo plugin update paseo-file-upload
paseo plugin ls paseo-file-upload --json
```

A local-directory installation cannot use `paseo plugin update`. After replacing the source, run:

```bash
npm ci --include=dev --ignore-scripts
npm run check
paseo plugin reload paseo-file-upload
```

If you previously installed from a local directory or the old `paseo-file-upload` repository, remove it before installing from this repository:

```bash
paseo plugin remove paseo-file-upload
paseo plugin add lalaze/paseo-plugins --path file-upload
paseo plugin ls paseo-file-upload --json
```

## Uninstallation

```bash
paseo plugin remove paseo-file-upload
```

Removing the plugin in Paseo 0.8.0 does not delete workspace files. Transfer sessions are cleaned up when the plugin exits. If the daemon is force-killed, `.paseo-upload-*` temporary files may remain; delete them manually after confirming that no transfer is active. For failures, inspect:

```bash
paseo plugin logs paseo-file-upload
```

## Local-directory development

If the repository is already cloned, run the following in `file-upload`:

```bash
npm ci --include=dev --ignore-scripts
npm run check
paseo plugin install "$PWD"
paseo plugin ls paseo-file-upload --json
```

`paseo plugin install` records the directory path. If you move this repository, reinstall any plugin installed from that path.

## Compatibility and limitations

- Developed and compile-tested against the local official **0.8.0** SDK, using separate client and server entry points. It is not compatible with the older 0.7 release.
- Transfer features are available in the desktop app and on the web. Native iOS and Android clients display usage guidance.
- Each file is limited to **100 MiB**. Downloads are assembled in client memory and then passed to the browser for saving; browser settings determine the destination.
- Only regular files are transferred. Compress folders into ZIP archives first. Symbolic links, `.git`, and plugin temporary files are hidden and cannot be accessed.
- Uploads do not create missing directories automatically. Overwriting, resuming, downloading folders as archives, and moving files inside the workspace are unsupported.
- The server obtains the path from the workspace ID; clients cannot specify an arbitrary root. Path traversal and symbolic links are checked, but this is not an OS sandbox against a malicious local process that replaces directories concurrently.
- Idle upload sessions are cleaned up after 15 minutes, and normal plugin shutdown also cleans up sessions. A force-killed daemon may leave `.paseo-upload-*` temporary files; delete them manually after confirming no transfer is active.

## Development and verification

```bash
npm ci --include=dev --ignore-scripts
npm run typecheck
npm test
npm run preview
```

The preview uses the real file-transfer backend with simulated Paseo hooks. It operates only on an automatically created temporary directory, never on a real project, and removes that directory on exit. It binds to `0.0.0.0:4173` by default; use `PORT=4198 npm run preview` to choose another port.

Verification covers type checking; binary chunk round trips, empty files, path restrictions, duplicate-name races, cancellation, file-change detection, and session resource limits; plus browser drag-to-folder uploads and byte-for-byte download comparison. The standalone preview simulates host hooks and does not replace acceptance testing on a real daemon.

Layout: `index.client.tsx` / `index.server.ts` register contributions, `client/` contains the panel, `shared/` defines RPC contracts, `server/` handles file operations, `dev/` provides the isolated preview, and `tests/` contains regression tests.

API reference: [official Paseo v0.8 plugin reference](https://github.com/getpaseo/paseo/blob/v0.8.0/public-docs/plugins/v0.8/reference.md).
