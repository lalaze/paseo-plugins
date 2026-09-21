# Paseo File Transfer — archived source

This plugin's source is retained for reference and local development only. Do not install or update it as part of repository setup. `install-all.sh` and `update-all.sh` exclude it, including when an older copy is already installed. Archiving the source does not uninstall an existing copy.

An independent **File Transfer** workspace panel for **Paseo 0.8.x / 0.9.x (including prereleases)**. Files reside on the daemon host that owns the current workspace; uploads originate from, and downloads are saved to, the desktop app or browser you are using.

The preserved source lives in the [`file-upload/`](.) directory of the [`lalaze/paseo-plugins`](https://github.com/lalaze/paseo-plugins) multi-plugin repository.

## Features

- Browse the workspace in an expandable directory tree that loads subdirectories on demand and shows the actual path at the top.
- Drag one or more files from Finder or a file manager. Drop them on a folder row to upload there, or on a file row to upload to its containing folder; the destination row is highlighted.
- Click **Upload Files** to choose files, or click **Download** on a file row to save it locally.
- Chunked transfers, progress, cancellation, and per-file results for multiple uploads. Duplicate names produce an error and are never overwritten automatically.
- Files are published atomically after upload; canceled or expired sessions clean up temporary files.
- RPC traffic uses the existing Paseo connection, with no additional service or port.

This is a standalone panel and does not modify Paseo's built-in **Files** or **Changes** lists. Native drag-out to Finder is not currently available, so downloads use a button.

Open a workspace, press **⌘K** (**Ctrl+K** on Windows or Linux), and search for **File Transfer: Upload and Download**. It opens in the right-hand Explorer panel by default. You can also add **File Transfer** from the Explorer panel settings. Because the plugin is hosted only in the right-hand Explorer, it does not appear in the **+** menu of the center tab bar.

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
```

These commands only prepare dependencies and check the preserved source; they do not install it into the daemon.

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
