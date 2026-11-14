import { zip } from "fflate";

export interface ScannedFile {
  relativePath: string;
  name: string;
  size: number;
  type: string;
  lastModified: number;
  file: File;
}

export interface DirectoryScanSummary {
  rootName: string;
  files: ScannedFile[];
  totalBytes: number;
  folderCount: number;
  extensionCounts: Record<string, number>;
  sourceMode: "showDirectoryPicker" | "webkitdirectory" | "filePicker";
}

interface DirHandleLike {
  kind: "directory" | "file";
  name: string;
  values?: () => AsyncIterable<DirHandleLike>;
  getFile?: () => Promise<File>;
}

export function isDirectoryPickerSupported(): boolean {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const input = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function buildSummary(
  rootName: string,
  files: ScannedFile[],
  folders: Set<string>,
  sourceMode: DirectoryScanSummary["sourceMode"]
): DirectoryScanSummary {
  let totalBytes = 0;
  const extensionCounts: Record<string, number> = {};

  for (const f of files) {
    totalBytes += f.size;
    const dot = f.name.lastIndexOf(".");
    const ext = dot > 0 ? f.name.slice(dot + 1).toLowerCase() : "(sans ext)";
    extensionCounts[ext] = (extensionCounts[ext] ?? 0) + 1;
  }

  return {
    rootName,
    files,
    totalBytes,
    folderCount: folders.size,
    extensionCounts,
    sourceMode,
  };
}

export async function pickDirectoryNative(): Promise<DirectoryScanSummary> {
  const picker = (window as unknown as { showDirectoryPicker: () => Promise<DirHandleLike> })
    .showDirectoryPicker;
  const rootHandle = await picker();
  const files: ScannedFile[] = [];
  const folders = new Set<string>();

  async function walk(handle: DirHandleLike, prefix: string) {
    if (!handle.values) return;
    for await (const entry of handle.values()) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.kind === "directory") {
        folders.add(rel);
        await walk(entry, rel);
      } else if (entry.kind === "file" && entry.getFile) {
        const file = await entry.getFile();
        files.push({
          relativePath: rel,
          name: file.name,
          size: file.size,
          type: file.type || "application/octet-stream",
          lastModified: file.lastModified,
          file,
        });
      }
    }
  }

  await walk(rootHandle, "");
  return buildSummary(rootHandle.name, files, folders, "showDirectoryPicker");
}

export function scanFileList(
  fileList: FileList | File[],
  mode: "webkitdirectory" | "filePicker"
): DirectoryScanSummary {
  const arr = Array.from(fileList);
  const files: ScannedFile[] = [];
  const folders = new Set<string>();
  let rootName = "Fichiers sélectionnés";

  for (const file of arr) {
    const webkitRel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    const rel = webkitRel && webkitRel.length > 0 ? webkitRel : file.name;
    const parts = rel.split("/");
    if (parts.length > 1 && mode === "webkitdirectory") {
      rootName = parts[0];
      for (let i = 1; i < parts.length - 1; i++) {
        folders.add(parts.slice(1, i + 1).join("/"));
      }
    }
    files.push({
      relativePath: mode === "webkitdirectory" && parts.length > 1 ? parts.slice(1).join("/") : rel,
      name: file.name,
      size: file.size,
      type: file.type || "application/octet-stream",
      lastModified: file.lastModified,
      file,
    });
  }

  return buildSummary(rootName, files, folders, mode);
}

export async function packageSummaryAsZip(
  summary: DirectoryScanSummary
): Promise<{ blob: Blob; filename: string; sha256: string }> {
  const entries: Record<string, Uint8Array> = {};
  for (const item of summary.files) {
    const buf = await item.file.arrayBuffer();
    entries[item.relativePath] = new Uint8Array(buf);
  }

  const zipped = await new Promise<Uint8Array>((resolve, reject) => {
    zip(entries, { level: 6 }, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });

  const sha256 = await sha256Hex(zipped);
  const safeName = summary.rootName.replace(/[^a-zA-Z0-9._-]/g, "_") || "sounddrop-bundle";
  return {
    blob: new Blob([new Uint8Array(zipped)], { type: "application/zip" }),
    filename: `${safeName}.zip`,
    sha256,
  };
}
