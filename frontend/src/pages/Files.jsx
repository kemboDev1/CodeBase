import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown, ChevronRight, FileCode2, FilePlus, Folder, FolderOpen, FolderPlus, HardDrive,
  LoaderCircle, RefreshCw, Search, Trash2, X,
} from 'lucide-react';
import { api, pickFolder } from '../api/client.js';
import { useApp } from '../state/AppContext.jsx';
import { EmptyState, LoadingState } from '../components/MarkdownLite.jsx';
import CodeEditor from '../components/CodeEditor.jsx';

const BINARY_RE = /\.(png|jpe?g|gif|webp|ico|bmp|tiff|woff2?|ttf|otf|eot|zip|gz|7z|rar|exe|dll|node|pdf|mp4|mp3|wav|mov|class|jar|wasm|so|dylib)$/i;
// A directory either says so explicitly, carries children, or its path ends with a separator.
const DIR_KINDS = new Set(['dir', 'directory', 'folder']);

function nodeKind(node) {
  const declared = String(node?.kind || node?.type || '').toLowerCase();
  if (DIR_KINDS.has(declared)) return 'dir';
  if (declared && declared !== 'dir') return 'file';
  if (Array.isArray(node?.children)) return 'dir';
  return /[\\/]$/.test(String(node?.path || '')) ? 'dir' : 'file';
}

function normaliseNodes(nodes) {
  const list = Array.isArray(nodes) ? nodes : (nodes && typeof nodes === 'object' ? [nodes] : []);
  return list.map((node) => ({
    ...node,
    kind: nodeKind(node),
    children: Array.isArray(node?.children) ? normaliseNodes(node.children) : undefined,
  }));
}

function joinPath(base, name) {
  const separator = /\\/.test(base) || /^[A-Za-z]:/.test(base) ? '\\' : '/';
  return `${String(base || '').replace(/[\\/]+$/, '')}${separator}${name}`;
}

function parentPath(target) {
  const value = String(target || '');
  const index = Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/'));
  return index > 0 ? value.slice(0, index) : value;
}

function baseName(target) {
  const value = String(target || '');
  const index = Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/'));
  return index >= 0 ? value.slice(index + 1) : value;
}

function isMarkdown(path) {
  return /\.(md|markdown|mdx)$/i.test(String(path || ''));
}

function TreeNode({ node, depth, expanded, childrenMap, loadingPath, selectedPath, onToggle, onOpen, onNew, onDelete }) {
  const isDir = node?.kind === 'dir';
  const open = Boolean(expanded[node?.path]);
  const kids = childrenMap[node?.path];
  return (
    <div className="file-node" style={{ paddingLeft: `${depth * 12}px` }}>
      <div className={`file-row ${selectedPath === node?.path ? 'selected' : ''}`}>
        <button
          type="button"
          className="file-name"
          onClick={() => (isDir ? onToggle(node) : onOpen(node))}
          title={node?.path}
        >
          {isDir
            ? (open ? <ChevronDown size={13} /> : <ChevronRight size={13} />)
            : <span className="file-indent" />}
          {isDir ? (open ? <FolderOpen size={14} /> : <Folder size={14} />) : <FileCode2 size={14} />}
          <span className="file-label">{node?.name || node?.path}</span>
          {Number.isFinite(node?.size) ? <span className="file-size">{node.size} B</span> : null}
        </button>
        <div className="file-actions">
          {isDir ? (
            <>
              <button type="button" className="icon-btn tiny" title="Yangi fayl" onClick={() => onNew('file', node.path)}><FilePlus size={12} /></button>
              <button type="button" className="icon-btn tiny" title="Yangi papka" onClick={() => onNew('dir', node.path)}><FolderPlus size={12} /></button>
            </>
          ) : null}
          <button type="button" className="icon-btn tiny" title="O‘chirish" onClick={() => onDelete(node)}><Trash2 size={12} /></button>
        </div>
      </div>
      {isDir && open ? (
        loadingPath === node.path && !kids
          ? <div className="file-loading"><LoaderCircle className="spin" size={12} /> yuklanmoqda…</div>
          : normaliseNodes(kids || []).map((child) => (
            <TreeNode
              key={child?.path || child?.name}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              childrenMap={childrenMap}
              loadingPath={loadingPath}
              selectedPath={selectedPath}
              onToggle={onToggle}
              onOpen={onOpen}
              onNew={onNew}
              onDelete={onDelete}
            />
          ))
      ) : null}
    </div>
  );
}

export default function Files() {
  const { settings = {}, pushToast, loading } = useApp();
  const roots = useMemo(() => (Array.isArray(settings?.workspaceRoots) ? settings.workspaceRoots : []), [settings?.workspaceRoots]);

  const [root, setRoot] = useState(roots[0] || '');
  const [tree, setTree] = useState([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState('');
  const [expanded, setExpanded] = useState({});
  const [childrenMap, setChildrenMap] = useState({});
  const [loadingPath, setLoadingPath] = useState('');

  const [selectedPath, setSelectedPath] = useState('');
  const [file, setFile] = useState(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState([]);
  const [searching, setSearching] = useState(false);
  const searchToken = useRef(0);

  const base = root || roots[0] || '';

  useEffect(() => {
    if (!base && roots.length) setRoot(roots[0]);
  }, [roots, base]);

  const loadRoot = useCallback(async (target = base) => {
    if (!target) {
      setTree([]);
      return;
    }
    setTreeLoading(true);
    setTreeError('');
    try {
      const data = await api('/files/tree', { query: { root: target, depth: 1 } });
      setTree(normaliseNodes(data?.tree || []));
      setChildrenMap({});
      setExpanded({});
    } catch (err) {
      setTree([]);
      setTreeError(err?.message || 'Papkani o‘qib bo‘lmadi');
    } finally {
      setTreeLoading(false);
    }
  }, [base]);

  useEffect(() => { loadRoot(base); }, [base, loadRoot]);

  const toggleDir = useCallback(async (node) => {
    const path = node?.path;
    if (!path) return;
    if (expanded[path]) {
      setExpanded((prev) => ({ ...prev, [path]: false }));
      return;
    }
    setExpanded((prev) => ({ ...prev, [path]: true }));
    if (childrenMap[path]) return;
    setLoadingPath(path);
    try {
      const data = await api('/files/tree', { query: { root: path, depth: 1 } });
      setChildrenMap((prev) => ({ ...prev, [path]: normaliseNodes(data?.tree || []) }));
    } catch (err) {
      pushToast(`Papka: ${err?.message || 'xato'}`, 'error');
      setExpanded((prev) => ({ ...prev, [path]: false }));
    } finally {
      setLoadingPath('');
    }
  }, [expanded, childrenMap, pushToast]);

  const openFile = useCallback(async (node) => {
    const path = node?.path;
    if (!path) return;
    if (BINARY_RE.test(path)) {
      pushToast('Binary fayl tahrirlanmaydi.', 'warn');
      return;
    }
    setFileLoading(true);
    setSelectedPath(path);
    try {
      const data = await api('/files/read', { query: { path } });
      const content = typeof data?.content === 'string' ? data.content : '';
      setFile({ path: data?.path || path, content, size: data?.size, truncated: Boolean(data?.truncated) });
      setDraft(content);
    } catch (err) {
      setFile(null);
      pushToast(`Fayl: ${err?.message || 'o‘qib bo‘lmadi'}`, 'error');
    } finally {
      setFileLoading(false);
    }
  }, [pushToast]);

  const saveFile = useCallback(async (content) => {
    if (!file?.path) return undefined;
    setSaving(true);
    try {
      const data = await api('/files/write', { method: 'POST', body: { path: file.path, content } });
      setFile((prev) => (prev ? { ...prev, content, size: data?.size ?? prev.size } : prev));
      pushToast(`Saqlandi: ${file.path}`, 'ok');
      loadRoot(base);
      return content;
    } catch (err) {
      pushToast(`Saqlash: ${err?.message || 'xato'}`, 'error');
      return undefined;
    } finally {
      setSaving(false);
    }
  }, [file?.path, pushToast, loadRoot, base]);

  /** Re-read one already-expanded folder without collapsing the rest of the tree. */
  const refreshFolder = useCallback(async (folder) => {
    if (!folder) return;
    setLoadingPath(folder);
    try {
      const data = await api('/files/tree', { query: { root: folder, depth: 1 } });
      setChildrenMap((prev) => ({ ...prev, [folder]: normaliseNodes(data?.tree || []) }));
    } catch (err) {
      pushToast(`Papka: ${err?.message || 'xato'}`, 'error');
    } finally {
      setLoadingPath('');
    }
  }, [pushToast]);

  const createEntry = useCallback(async (kind, parent) => {
    const target = kind === 'dir' ? parent : (parent || base);
    const label = kind === 'dir' ? 'Yangi papka nomi' : 'Yangi fayl nomi (masalan app.js)';
    const name = window.prompt(label, kind === 'dir' ? 'new-folder' : 'new-file.js');
    if (!name || !name.trim()) return;
    const path = joinPath(target, name.trim());
    try {
      if (kind === 'dir') await api('/files/mkdir', { method: 'POST', body: { path } });
      else await api('/files/write', { method: 'POST', body: { path, content: '' } });
      pushToast(kind === 'dir' ? `Papka yaratildi: ${path}` : `Fayl yaratildi: ${path}`, 'ok');
      if (parent && parent !== base) {
        setExpanded((prev) => ({ ...prev, [parent]: true }));
        refreshFolder(parent);
      } else {
        loadRoot(base);
      }
    } catch (err) {
      pushToast(`Yaratish: ${err?.message || 'xato'}`, 'error');
    }
  }, [base, pushToast, loadRoot, refreshFolder]);

  const deleteEntry = useCallback(async (node) => {
    if (!node?.path) return;
    const ok = window.confirm(`“${node.name || node.path}” o‘chiriladi. Bu amalni qaytarib bo‘lmaydi. Davom etamizmi?`);
    if (!ok) return;
    try {
      await api('/files/delete', { method: 'POST', body: { path: node.path } });
      pushToast(`O‘chirildi: ${node.name || node.path}`, 'ok');
      if (selectedPath === node.path) {
        setFile(null);
        setSelectedPath('');
      }
      const parent = parentPath(node.path);
      if (childrenMap[parent]) refreshFolder(parent);
      else loadRoot(base);
    } catch (err) {
      pushToast(`O‘chirish: ${err?.message || 'xato'}`, 'error');
    }
  }, [pushToast, selectedPath, loadRoot, base, childrenMap, refreshFolder]);

  const moveEntry = useCallback(async (node) => {
    if (!node?.path) return;
    const name = window.prompt('Yangi nom yoki to‘liq yo‘l', baseName(node.path));
    if (!name || !name.trim() || name.trim() === baseName(node.path)) return;
    const typed = name.trim();
    const to = typed.includes('\\') || typed.includes('/') ? typed : joinPath(parentPath(node.path), typed);
    try {
      await api('/files/move', { method: 'POST', body: { from: node.path, to } });
      pushToast(`Ko‘chirildi: ${to}`, 'ok');
      if (selectedPath === node.path) {
        setFile((prev) => (prev ? { ...prev, path: to } : prev));
        setSelectedPath(to);
      }
      loadRoot(base);
    } catch (err) {
      pushToast(`Ko‘chirish: ${err?.message || 'xato'}`, 'error');
    }
  }, [pushToast, loadRoot, base, selectedPath]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setMatches([]);
      setSearching(false);
      return undefined;
    }
    const token = ++searchToken.current;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const data = await api('/files/search', { query: { q, root: base || undefined, max: 40 } });
        if (token !== searchToken.current) return;
        setMatches(Array.isArray(data?.matches) ? data.matches : []);
      } catch (err) {
        if (token === searchToken.current) pushToast(`Qidiruv: ${err?.message || 'xato'}`, 'error');
      } finally {
        if (token === searchToken.current) setSearching(false);
      }
    }, 320);
    return () => clearTimeout(timer);
  }, [query, base, pushToast]);

  async function browseRoot() {
    const picked = await pickFolder();
    if (!picked) {
      if (!window.codebase) pushToast('Papka tanlash faqat desktop ilovada ishlaydi.', 'warn');
      return;
    }
    if (!roots.includes(picked)) {
      pushToast('Bu papka workspace roots ro‘yxatida yo‘q. Settings bo‘limida qo‘shishingiz mumkin.', 'warn');
    }
    setRoot(picked);
  }

  const hasRoots = roots.length > 0;

  return (
    <section className="content-page files-page">
      <div className="page-heading">
        <div>
          <div className="page-kicker">WORKSPACE FILES</div>
          <h1>Files<span className="heading-dot">.</span></h1>
          <p>Faqat workspace root ichidagi fayllar ochiladi. Saqlash <code>POST /files/write</code> orqali, path jail backendda tekshiriladi.</p>
        </div>
        <div className="cb-heading-actions">
          <button type="button" className="secondary-btn" onClick={() => createEntry('file', base)} disabled={!base}>
            <FilePlus size={15} /> New file
          </button>
          <button type="button" className="secondary-btn" onClick={() => createEntry('dir', base)} disabled={!base}>
            <FolderPlus size={15} /> New folder
          </button>
          <button type="button" className="primary-btn" onClick={browseRoot}>
            <FolderOpen size={15} /> Open folder
          </button>
        </div>
      </div>

      <div className="files-toolbar">
        <div className="cb-select">
          <HardDrive size={14} />
          <select value={base} onChange={(event) => setRoot(event.target.value)} disabled={!hasRoots}>
            {!hasRoots ? <option value="">Workspace root yo‘q</option> : null}
            {roots.map((item) => <option value={item} key={item}>{item}</option>)}
            {base && !roots.includes(base) ? <option value={base}>{base}</option> : null}
          </select>
          <ChevronDown size={13} />
        </div>
        <div className="files-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Fayl kontenti bo‘yicha qidirish…"
            spellCheck={false}
            aria-label="Qidiruv"
          />
          {searching ? <LoaderCircle className="spin" size={13} /> : null}
          {query ? <button type="button" className="icon-btn tiny" onClick={() => setQuery('')} title="Tozalash"><X size={12} /></button> : null}
        </div>
        <button type="button" className="ghost-btn" onClick={() => loadRoot(base)} disabled={!base}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {!hasRoots ? (
        <div className="panel-card">
          <EmptyState
            icon={<HardDrive size={21} />}
            title="Workspace root sozlanmagan"
            hint="Settings → Workspace roots bo‘limida papka qo‘shing yoki “Open folder” bilan vaqtincha papka tanlang."
          />
        </div>
      ) : (
        <div className="files-layout">
          <div className="files-tree panel-card">
            <div className="panel-title">
              <h3>Tree</h3>
              <span>{tree.length} items</span>
            </div>
            {treeLoading && !tree.length ? <LoadingState text="Papka o‘qilmoqda…" rows={4} /> : null}
            {treeError ? <div className="cb-inline-error">{treeError}</div> : null}
            {!treeLoading && !treeError && !tree.length ? (
              <EmptyState compact icon={<Folder size={18} />} title="Papka bo‘sh" hint="Bu root ichida ko‘rsatiladigan fayl topilmadi." />
            ) : null}
            <div className="file-tree">
              {tree.map((node) => (
                <TreeNode
                  key={node?.path || node?.name}
                  node={node}
                  depth={0}
                  expanded={expanded}
                  childrenMap={childrenMap}
                  loadingPath={loadingPath}
                  selectedPath={selectedPath}
                  onToggle={toggleDir}
                  onOpen={openFile}
                  onNew={createEntry}
                  onDelete={deleteEntry}
                />
              ))}
            </div>
            {matches.length ? (
              <div className="files-matches">
                <div className="panel-title"><h3>Search results</h3><span>{matches.length}</span></div>
                {matches.map((match, index) => (
                  <button
                    type="button"
                    className="match-row"
                    key={`${match?.path || index}-${match?.line || 0}`}
                    onClick={() => (match?.path ? openFile({ path: match.path, name: match.path }) : null)}
                  >
                    <b>{match?.path || 'unknown'}</b>
                    {match?.line !== undefined ? <span className="match-line">:{match.line}</span> : null}
                    <span className="match-text">{match?.text || match?.preview || ''}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {query && !searching && !matches.length ? <div className="cb-inline-note">“{query}” uchun natija topilmadi.</div> : null}
          </div>

          <div className="files-editor panel-card">
            {fileLoading ? <LoadingState text="Fayl o‘qilmoqda…" rows={5} /> : null}
            {!fileLoading && !file ? (
              <EmptyState
                icon={<FileCode2 size={21} />}
                title="Fayl tanlanmagan"
                hint="Chapdagi daraxtdan fayl tanlang yoki yangi fayl yarating."
              />
            ) : null}
            {!fileLoading && file ? (
              <>
                <CodeEditor
                  path={file.path}
                  value={draft}
                  onChange={setDraft}
                  onSave={saveFile}
                  size={file.size}
                  truncated={file.truncated}
                  saving={saving}
                  readOnly={Boolean(file.truncated)}
                />
                <div className="editor-extras">
                  <button type="button" className="ghost-btn" onClick={() => moveEntry(file)}>
                    Rename / move
                  </button>
                  <button type="button" className="ghost-btn danger" onClick={() => deleteEntry({ path: file.path, name: baseName(file.path) })}>
                    <Trash2 size={13} /> Delete file
                  </button>
                  {isMarkdown(file.path) ? (
                    <span className="editor-note-inline">
                      <b>.md</b> fayl — saqlangandan keyin Skills → Import bilan skill sifatida qo‘shish mumkin.
                    </span>
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
        </div>
      )}

      {loading && !hasRoots ? <LoadingState text="Sozlamalar yuklanmoqda…" /> : null}
    </section>
  );
}
