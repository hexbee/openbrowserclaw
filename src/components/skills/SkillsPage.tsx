import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, RefreshCw, Save, Trash2, Wrench } from 'lucide-react';
import type { SkillRecord } from '../../types.js';
import { loadSkills } from '../../skills.js';
import {
  createUserSkillScaffold,
  deleteUserSkill,
  readUserSkillMarkdown,
  validateSkillName,
  writeUserSkillMarkdown,
} from '../../skill-management.js';
import { getOrchestrator } from '../../stores/orchestrator-store.js';

export function SkillsPage() {
  const orch = getOrchestrator();
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [selectedName, setSelectedName] = useState<string>('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newSkillName, setNewSkillName] = useState('');
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const userSkills = useMemo(
    () => skills.filter((s) => s.source === 'user').sort((a, b) => a.name.localeCompare(b.name)),
    [skills],
  );

  const selected = useMemo(
    () => userSkills.find((s) => s.name === selectedName) || null,
    [userSkills, selectedName],
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const all = await loadSkills();
      setSkills(all);

      const users = all.filter((s) => s.source === 'user').sort((a, b) => a.name.localeCompare(b.name));
      if (users.length === 0) {
        setSelectedName('');
        setContent('');
        return;
      }

      const next = users.some((s) => s.name === selectedName) ? selectedName : users[0].name;
      setSelectedName(next);
      const markdown = await readUserSkillMarkdown(next);
      setContent(markdown);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [selectedName]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleSelectSkill(name: string) {
    setSelectedName(name);
    setError(null);
    try {
      const markdown = await readUserSkillMarkdown(name);
      setContent(markdown);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setContent('');
    }
  }

  async function handleCreateSkill() {
    const name = newSkillName.trim();
    const nameError = validateSkillName(name);
    if (nameError) {
      setError(nameError);
      return;
    }

    setCreating(true);
    setError(null);
    try {
      await createUserSkillScaffold(name);
      await orch.refreshSkills();
      await loadData();
      setSelectedName(name);
      setNewSkillName('');
      const markdown = await readUserSkillMarkdown(name);
      setContent(markdown);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleSave() {
    if (!selectedName) return;
    setSaving(true);
    setError(null);
    try {
      await writeUserSkillMarkdown(selectedName, content);
      await orch.refreshSkills();
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(name: string) {
    setError(null);
    try {
      await deleteUserSkill(name);
      await orch.refreshSkills();
      setDeleteTarget(null);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="h-full overflow-hidden p-4 sm:p-6 max-w-6xl mx-auto flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Wrench className="w-5 h-5" /> Skills
        </h2>
        <button className="btn btn-outline btn-sm gap-1.5" onClick={loadData} disabled={loading}>
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      <div className="card card-bordered bg-base-200">
        <div className="card-body p-4 sm:p-5">
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              className="input input-bordered input-sm flex-1"
              placeholder="new-skill-name"
              value={newSkillName}
              onChange={(e) => setNewSkillName(e.target.value)}
            />
            <button
              className="btn btn-primary btn-sm gap-1.5"
              onClick={handleCreateSkill}
              disabled={creating || !newSkillName.trim()}
            >
              <Plus className="w-4 h-4" /> New Skill
            </button>
          </div>
          <p className="text-xs opacity-60 mt-2">
            New skill scaffold creates: <code>SKILL.md</code>, <code>scripts/.gitkeep</code>, <code>references/.gitkeep</code>, <code>assets/.gitkeep</code>.
          </p>
        </div>
      </div>

      {error && <div role="alert" className="alert alert-error py-2 text-sm">{error}</div>}

      <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[280px_minmax(0,1fr)] gap-4">
        <div className="card card-bordered bg-base-200 min-h-0">
          <div className="card-body p-3 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <span className="loading loading-spinner loading-md" />
              </div>
            ) : userSkills.length === 0 ? (
              <p className="text-sm opacity-60">No user skills yet.</p>
            ) : (
              <div className="space-y-2">
                {userSkills.map((skill) => (
                  <button
                    key={skill.name}
                    className={`w-full text-left p-2 rounded border ${selectedName === skill.name ? 'border-primary bg-base-100' : 'border-base-300 bg-base-200'}`}
                    onClick={() => handleSelectSkill(skill.name)}
                  >
                    <div className="font-medium text-sm">{skill.name}</div>
                    <div className="text-xs opacity-70 mt-0.5">
                      {skill.valid ? 'valid' : 'invalid'}
                    </div>
                    {!skill.valid && skill.errors.length > 0 && (
                      <div className="text-xs text-error mt-1 line-clamp-2">
                        {skill.errors.map((e) => e.message).join('; ')}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="card card-bordered bg-base-200 min-h-0">
          <div className="card-body p-3 sm:p-4 h-full">
            {!selected ? (
              <div className="h-full flex items-center justify-center text-sm opacity-60">
                Select or create a skill to edit SKILL.md
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between mb-2 gap-2">
                  <div className="min-w-0">
                    <div className="font-medium truncate">{selected.name}</div>
                    <div className="text-xs opacity-70">
                      /skills/{selected.name}/SKILL.md
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      className="btn btn-error btn-outline btn-sm gap-1.5"
                      onClick={() => setDeleteTarget(selected.name)}
                    >
                      <Trash2 className="w-4 h-4" /> Delete
                    </button>
                    <button
                      className="btn btn-primary btn-sm gap-1.5"
                      onClick={handleSave}
                      disabled={saving}
                    >
                      <Save className="w-4 h-4" /> Save
                    </button>
                  </div>
                </div>

                <textarea
                  className="textarea textarea-bordered w-full flex-1 min-h-[300px] font-mono text-xs"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  spellCheck={false}
                />
              </>
            )}
          </div>
        </div>
      </div>

      {deleteTarget && (
        <dialog className="modal modal-open">
          <div className="modal-box max-w-sm">
            <h3 className="font-bold text-lg">Delete skill?</h3>
            <p className="py-4">
              Delete <strong>{deleteTarget}</strong> and all files under <code>/skills/{deleteTarget}</code>.
            </p>
            <div className="modal-action">
              <button className="btn btn-ghost" onClick={() => setDeleteTarget(null)}>
                Cancel
              </button>
              <button className="btn btn-error" onClick={() => handleDelete(deleteTarget)}>
                Delete
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button onClick={() => setDeleteTarget(null)}>close</button>
          </form>
        </dialog>
      )}
    </div>
  );
}
