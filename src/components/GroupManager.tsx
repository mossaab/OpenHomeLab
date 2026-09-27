import { useEffect, useRef, useState } from 'react';
import { apiCall } from '../api';
import type { Group } from '../types';
import { GROUP_COLORS, GROUP_ICONS, groupColorSpec, groupIcon } from '../groupOptions';
import { GripVertical, Plus, Trash2, X } from 'lucide-react';
import Modal from './Modal';
import ConfirmDialog from './ConfirmDialog';
import { useToast } from './Toast';
import { useI18n } from '../i18n';

interface GroupManagerProps {
  groups: Group[];
  onClose: () => void;
  onChanged: () => void;
}

const byPos = (a: Group, b: Group) => a.position - b.position || a.id - b.id;

export default function GroupManager({ groups, onClose, onChanged }: GroupManagerProps) {
  const { t } = useI18n();
  const [items, setItems] = useState<Group[]>(() => [...groups].sort(byPos));
  const [names, setNames] = useState<Record<number, string>>(() => Object.fromEntries(groups.map((g) => [g.id, g.name])));
  const [iconPickerFor, setIconPickerFor] = useState<number | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [overId, setOverId] = useState<number | null>(null);
  const [overEnd, setOverEnd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newIcon, setNewIcon] = useState('boxes');
  const [newColor, setNewColor] = useState('slate');
  const [busy, setBusy] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Group | null>(null);
  const dirtyNames = useRef<Set<number>>(new Set());
  const { addToast } = useToast();

  useEffect(() => {
    setItems([...groups].sort(byPos));
    setNames((prev) => {
      const next: Record<number, string> = {};
      for (const g of groups) {
        next[g.id] = dirtyNames.current.has(g.id) && prev[g.id] !== undefined ? prev[g.id] : g.name;
      }
      return next;
    });
  }, [groups]);

  const patchGroup = async (id: number, patch: Partial<Pick<Group, 'name' | 'icon' | 'color'>>) => {
    try {
      await apiCall(`/groups/${id}`, { method: 'PUT', body: JSON.stringify(patch) });
      onChanged();
    } catch (e: any) {
      addToast('error', e.message || t('groups.failedUpdate'));
    }
  };

  const commitRename = (group: Group) => {
    dirtyNames.current.delete(group.id);
    const value = (names[group.id] ?? '').trim();
    if (!value || value === group.name) {
      setNames((prev) => ({ ...prev, [group.id]: group.name }));
      return;
    }
    void patchGroup(group.id, { name: value });
  };

  const persistOrder = (ids: number[]) => {
    setItems((prev) => prev.map((g) => ({ ...g, position: ids.indexOf(g.id) })));
    apiCall('/groups/reorder', { method: 'POST', body: JSON.stringify({ ids }) })
      .then(() => onChanged())
      .catch((e: any) => {
        addToast('error', e.message || t('groups.failedReorder'));
        onChanged();
      });
  };

  const reorder = (fromId: number, toId: number) => {
    if (fromId === toId) return;
    const ids = items.map((g) => g.id);
    const from = ids.indexOf(fromId);
    if (from < 0) return;
    ids.splice(from, 1);
    const to = ids.indexOf(toId);
    if (to < 0) return;
    ids.splice(to, 0, fromId);
    persistOrder(ids);
  };

  const reorderToEnd = (fromId: number) => {
    const ids = items.map((g) => g.id);
    const from = ids.indexOf(fromId);
    if (from < 0 || ids.length < 2) return;
    ids.splice(from, 1);
    ids.push(fromId);
    persistOrder(ids);
  };

  const handleAdd = async () => {
    const value = newName.trim();
    if (!value) return;
    setBusy(true);
    try {
      await apiCall<{ id: number }>('/groups', { method: 'POST', body: JSON.stringify({ name: value, icon: newIcon, color: newColor }) });
      setNewName('');
      onChanged();
    } catch (e: any) {
      addToast('error', e.message || t('groups.failedCreate'));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await apiCall(`/groups/${deleteTarget.id}`, { method: 'DELETE' });
      setDeleteTarget(null);
      onChanged();
      addToast('success', t('groups.deletedToast'));
    } catch (e: any) {
      addToast('error', e.message || t('groups.failedDelete'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal onBackdropClick={onClose} className="w-full sm:max-w-lg max-h-[88dvh] overflow-y-auto custom-scrollbar rounded-2xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-bold text-lg text-slate-900 dark:text-slate-100">{t('groups.title')}</h3>
        <button
          onClick={onClose}
          className="p-2 glass border border-slate-200 dark:border-white/10 rounded-lg text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 transition-colors"
          title={t('common.close')}
        >
          <X size={16} />
        </button>
      </div>

      {items.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">{t('groups.noneYet')}</p>
      ) : (
        <div className="flex flex-col gap-2 mb-4">
          {items.map((g) => {
            const Icon = groupIcon(g.icon);
            const color = groupColorSpec(g.color);
            return (
              <div
                key={g.id}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOverEnd(false);
                  if (dragId !== null && dragId !== g.id) setOverId(g.id);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragId !== null && dragId !== g.id) reorder(dragId, g.id);
                  setDragId(null);
                  setOverId(null);
                  setOverEnd(false);
                }}
                className={`rounded-xl border p-3 transition-colors ${
                  overId === g.id ? 'border-indigo-500 bg-indigo-500/10' : 'border-slate-200 dark:border-white/10'
                } ${dragId === g.id ? 'opacity-50' : ''}`}
              >
                <div className="flex items-center gap-2">
                  <span
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move';
                      setDragId(g.id);
                      setOverId(null);
                      setOverEnd(false);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setOverId(null);
                      setOverEnd(false);
                    }}
                    className="cursor-grab text-slate-400 dark:text-slate-500 shrink-0"
                    title={t('groups.dragReorder')}
                  >
                    <GripVertical size={16} />
                  </span>
                  <button
                    onClick={() => setIconPickerFor(iconPickerFor === g.id ? null : g.id)}
                    className={`w-8 h-8 rounded-lg border flex items-center justify-center shrink-0 ${color.chip}`}
                    title={t('groups.changeIcon')}
                  >
                    <Icon size={15} />
                  </button>
                  <input
                    value={names[g.id] ?? g.name}
                    onChange={(e) => {
                      dirtyNames.current.add(g.id);
                      setNames((prev) => ({ ...prev, [g.id]: e.target.value }));
                    }}
                    onBlur={() => commitRename(g)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    }}
                    className="flex-1 min-w-0 bg-transparent border-b border-transparent focus:border-indigo-500 text-sm font-semibold text-slate-800 dark:text-slate-200 focus:outline-none"
                  />
                  <div className="flex items-center gap-1 shrink-0">
                    {GROUP_COLORS.map((c) => (
                      <button
                        key={c.value}
                        onClick={() => void patchGroup(g.id, { color: c.value })}
                        className={`w-4 h-4 rounded-full ${c.swatch} transition-transform ${g.color === c.value ? 'ring-2 ring-offset-1 ring-slate-400 dark:ring-white/40 ring-offset-transparent scale-110' : 'opacity-60 hover:opacity-100'}`}
                        title={c.label}
                      />
                    ))}
                  </div>
                  <button
                    onClick={() => setDeleteTarget(g)}
                    className="p-1.5 rounded-lg text-slate-400 dark:text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 hover:bg-rose-500/10 transition-colors shrink-0"
                    title={t('groups.deleteGroup')}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                {iconPickerFor === g.id && (
                  <div className="mt-3 pt-3 border-t border-slate-200 dark:border-white/10 flex flex-wrap gap-1.5">
                    {Object.entries(GROUP_ICONS).map(([value, Ico]) => (
                      <button
                        key={value}
                        onClick={() => {
                          setIconPickerFor(null);
                          void patchGroup(g.id, { icon: value });
                        }}
                        className={`w-8 h-8 rounded-lg border flex items-center justify-center transition-colors ${
                          g.icon === value ? color.chip : 'border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-white/10'
                        }`}
                      >
                        <Ico size={14} />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setOverId(null);
              if (dragId !== null) setOverEnd(true);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (dragId !== null) reorderToEnd(dragId);
              setDragId(null);
              setOverId(null);
              setOverEnd(false);
            }}
            className={`rounded-xl border border-dashed px-3 py-2.5 text-center text-[11px] font-bold uppercase tracking-wider transition-colors ${
              overEnd && dragId !== null ? 'border-indigo-500 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300' : 'border-slate-200 dark:border-white/10 text-slate-400 dark:text-slate-500'
            }`}
          >
            {t('groups.dropEnd')}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-dashed border-slate-300 dark:border-white/15 p-3">
        <div className="flex items-center gap-2 mb-3">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleAdd();
            }}
            placeholder={t('groups.placeholder')}
            className="flex-1 min-w-0 bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-200 placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
          <button
            onClick={() => void handleAdd()}
            disabled={busy || !newName.trim()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-sm font-bold transition-colors shrink-0"
          >
            <Plus size={15} /> {t('groups.addBtn')}
          </button>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex flex-wrap gap-1">
            {Object.entries(GROUP_ICONS).map(([value, Ico]) => (
              <button
                key={value}
                onClick={() => setNewIcon(value)}
                className={`w-7 h-7 rounded-md border flex items-center justify-center transition-colors ${
                  newIcon === value
                    ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-600 dark:text-indigo-300'
                    : 'border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 hover:bg-slate-200/60 dark:hover:bg-white/10'
                }`}
              >
                <Ico size={13} />
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 ms-auto">
            {GROUP_COLORS.map((c) => (
              <button
                key={c.value}
                onClick={() => setNewColor(c.value)}
                className={`w-4 h-4 rounded-full ${c.swatch} transition-transform ${newColor === c.value ? 'ring-2 ring-offset-1 ring-slate-400 dark:ring-white/40 scale-110' : 'opacity-60 hover:opacity-100'}`}
                title={c.label}
              />
            ))}
          </div>
        </div>
      </div>

      {deleteTarget && (
        <ConfirmDialog
          title={t('groups.deleteGroup')}
          message={t('groups.confirmMessage', { name: deleteTarget.name })}
          confirmLabel={t('common.delete')}
          loading={busy}
          onConfirm={() => void handleDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </Modal>
  );
}
