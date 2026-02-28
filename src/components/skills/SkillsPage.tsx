import { useCallback, useEffect, useMemo, useState } from 'react';
import { Download, Plus, RefreshCw, Save, Trash2, Wrench } from 'lucide-react';
import type {
  GitHubDiscoveredSkill,
  GitHubSkillCollectionDiscovery,
  GitHubSkillForceUpdatePreview,
  GitHubRateLimitStatus,
  GitHubSkillSourceMetadata,
  GitHubSkillUpdateCheckResult,
  SkillRecord,
} from '../../types.js';
import { getConfig } from '../../db.js';
import { CONFIG_KEYS } from '../../config.js';
import { loadSkills } from '../../skills.js';
import {
  checkGitHubSkillUpdate,
  createUserSkillScaffold,
  deleteUserSkill,
  discoverGitHubSkillInstallTarget,
  forceUpdateGitHubSkill,
  getGitHubRateLimitStatus,
  installSkillFromGitHubUrl,
  installSelectedGitHubSkills,
  previewGitHubSkillForceUpdate,
  readGitHubSkillSourceMetadata,
  readUserSkillMarkdown,
  validateSkillName,
  writeUserSkillMarkdown,
} from '../../skill-management.js';
import { getOpfsUnsupportedMessage, isOpfsAvailable } from '../../opfs.js';
import { getOrchestrator } from '../../stores/orchestrator-store.js';

type SkillListUpdateStatus =
  | { kind: 'manual' }
  | { kind: 'auto-check-off' }
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  | { kind: 'update-available' }
  | { kind: 'check-failed' };

export function SkillsPage() {
  const orch = getOrchestrator();
  const opfsAvailable = isOpfsAvailable();
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [selectedName, setSelectedName] = useState<string>('');
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [newSkillName, setNewSkillName] = useState('');
  const [githubUrl, setGithubUrl] = useState('');
  const [creating, setCreating] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [bulkInstalling, setBulkInstalling] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [forcingUpdate, setForcingUpdate] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [selectedGitHubSource, setSelectedGitHubSource] = useState<GitHubSkillSourceMetadata | null>(null);
  const [updateResult, setUpdateResult] = useState<GitHubSkillUpdateCheckResult | null>(null);
  const [forceUpdatePreview, setForceUpdatePreview] = useState<GitHubSkillForceUpdatePreview | null>(null);
  const [preparingForceUpdate, setPreparingForceUpdate] = useState(false);
  const [skillUpdateStatuses, setSkillUpdateStatuses] = useState<Record<string, SkillListUpdateStatus>>({});
  const [gitHubRateLimit, setGitHubRateLimit] = useState<GitHubRateLimitStatus | null>(null);
  const [gitHubRateLimitError, setGitHubRateLimitError] = useState<string | null>(null);
  const [autoCheckUpdatesEnabled, setAutoCheckUpdatesEnabled] = useState(false);
  const [lastManualCheckAt, setLastManualCheckAt] = useState<string | null>(null);
  const [gitHubCollectionDiscovery, setGitHubCollectionDiscovery] = useState<GitHubSkillCollectionDiscovery | null>(null);
  const [gitHubCollectionFilter, setGitHubCollectionFilter] = useState('');
  const [selectedGitHubCollectionPaths, setSelectedGitHubCollectionPaths] = useState<string[]>([]);

  const userSkills = useMemo(
    () => skills.filter((s) => s.source === 'user').sort((a, b) => a.name.localeCompare(b.name)),
    [skills],
  );

  const selected = useMemo(
    () => userSkills.find((s) => s.name === selectedName) || null,
    [userSkills, selectedName],
  );

  const filteredGitHubCollectionSkills = useMemo(() => {
    if (!gitHubCollectionDiscovery) return [];
    const filter = gitHubCollectionFilter.trim().toLowerCase();
    if (!filter) return gitHubCollectionDiscovery.skills;
    return gitHubCollectionDiscovery.skills.filter((skill) =>
      skill.skillName.toLowerCase().includes(filter) ||
      skill.description.toLowerCase().includes(filter) ||
      skill.path.toLowerCase().includes(filter));
  }, [gitHubCollectionDiscovery, gitHubCollectionFilter]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(opfsAvailable ? null : getOpfsUnsupportedMessage());
    try {
      const all = await loadSkills();
      setSkills(all);

      const users = all.filter((s) => s.source === 'user').sort((a, b) => a.name.localeCompare(b.name));
      if (users.length === 0) {
        setSelectedName('');
        setContent('');
        setSelectedGitHubSource(null);
        setUpdateResult(null);
        return;
      }

      const next = users.some((s) => s.name === selectedName) ? selectedName : users[0].name;
      setSelectedName(next);
      const markdown = await readUserSkillMarkdown(next);
      setContent(markdown);
      const source = await readGitHubSkillSourceMetadata(next);
      setSelectedGitHubSource(source);
      setUpdateResult(null);
      setForceUpdatePreview(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [opfsAvailable, selectedName]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    refreshGitHubRateLimit();
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadAutoCheckPreference() {
      const enabled = (await getConfig(CONFIG_KEYS.SKILLS_AUTO_CHECK_UPDATES)) === 'true';
      if (!cancelled) {
        setAutoCheckUpdatesEnabled(enabled);
      }
    }

    loadAutoCheckPreference();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function refreshSkillUpdateStatuses() {
      if (!autoCheckUpdatesEnabled) {
        const nextStatuses: Record<string, SkillListUpdateStatus> = {};
        await Promise.all(userSkills.map(async (skill) => {
          const source = await readGitHubSkillSourceMetadata(skill.name);
          if (cancelled) return;
          nextStatuses[skill.name] = source ? { kind: 'auto-check-off' } : { kind: 'manual' };
        }));
        if (!cancelled) {
          setSkillUpdateStatuses(nextStatuses);
        }
        return;
      }

      const nextStatuses: Record<string, SkillListUpdateStatus> = {};
      const githubSkillNames: string[] = [];

      await Promise.all(userSkills.map(async (skill) => {
        const source = await readGitHubSkillSourceMetadata(skill.name);
        if (cancelled) return;
        if (!source) {
          nextStatuses[skill.name] = { kind: 'manual' };
          return;
        }
        nextStatuses[skill.name] = { kind: 'checking' };
        githubSkillNames.push(skill.name);
      }));

      if (cancelled) return;
      setSkillUpdateStatuses(nextStatuses);

      await Promise.all(githubSkillNames.map(async (name) => {
        try {
          const result = await checkGitHubSkillUpdate(name);
          if (cancelled) return;
          setSkillUpdateStatuses((current) => ({
            ...current,
            [name]: { kind: result.updateAvailable ? 'update-available' : 'up-to-date' },
          }));
        } catch {
          if (cancelled) return;
          setSkillUpdateStatuses((current) => ({
            ...current,
            [name]: { kind: 'check-failed' },
          }));
        }
      }));
    }

    refreshSkillUpdateStatuses();

    return () => {
      cancelled = true;
    };
  }, [autoCheckUpdatesEnabled, userSkills]);

  async function handleSelectSkill(name: string) {
    setSelectedName(name);
    setError(null);
    try {
      const markdown = await readUserSkillMarkdown(name);
      setContent(markdown);
      const source = await readGitHubSkillSourceMetadata(name);
      setSelectedGitHubSource(source);
      setUpdateResult(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setContent('');
      setSelectedGitHubSource(null);
      setUpdateResult(null);
      setForceUpdatePreview(null);
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
    setStatus(null);
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
    setStatus(null);
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
    setStatus(null);
    try {
      await deleteUserSkill(name);
      await orch.refreshSkills();
      setDeleteTarget(null);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleInstallFromGitHub() {
    const url = githubUrl.trim();
    if (!url) return;

    setInstalling(true);
    setError(null);
    setStatus('Checking GitHub target...');
    try {
      const target = await discoverGitHubSkillInstallTarget(url);
      if (target.kind === 'collection') {
        setGitHubCollectionDiscovery(target);
        setGitHubCollectionFilter('');
        setSelectedGitHubCollectionPaths([]);
        setStatus(`Found ${target.skills.length} installable skills. Select the ones you want to add.`);
      } else {
        const result = await installSkillFromGitHubUrl(url);
        await orch.refreshSkills();
        await loadData();
        setSelectedName(result.skillName);
        setGithubUrl('');
        const markdown = await readUserSkillMarkdown(result.skillName);
        setContent(markdown);
        const source = await readGitHubSkillSourceMetadata(result.skillName);
        setSelectedGitHubSource(source);
        setUpdateResult(null);
        setForceUpdatePreview(null);
        setStatus(`Installed ${result.skillName} (${result.fileCount} files).`);
      }
      await refreshGitHubRateLimit();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus(null);
    } finally {
      setInstalling(false);
    }
  }

  async function handleInstallSelectedGitHubSkills() {
    if (!gitHubCollectionDiscovery || selectedGitHubCollectionPaths.length === 0) return;

    const selectedSkills = gitHubCollectionDiscovery.skills.filter((skill) =>
      selectedGitHubCollectionPaths.includes(skill.path));
    if (selectedSkills.length === 0) return;

    setBulkInstalling(true);
    setError(null);
    setStatus(`Installing ${selectedSkills.length} selected skills from GitHub...`);
    try {
      const result = await installSelectedGitHubSkills(selectedSkills);
      const installed = result.results.filter((item) => item.status === 'installed');
      const skipped = result.results.filter((item) => item.status === 'skipped');
      const failed = result.results.filter((item) => item.status === 'failed');

      await orch.refreshSkills();
      await loadData();

      if (installed.length > 0) {
        const firstInstalled = installed[0].skillName;
        setSelectedName(firstInstalled);
        const markdown = await readUserSkillMarkdown(firstInstalled);
        setContent(markdown);
        const source = await readGitHubSkillSourceMetadata(firstInstalled);
        setSelectedGitHubSource(source);
        setUpdateResult(null);
        setForceUpdatePreview(null);
      }

      setGitHubCollectionDiscovery(null);
      setGitHubCollectionFilter('');
      setSelectedGitHubCollectionPaths([]);
      setGithubUrl('');
      setStatus(`${installed.length} installed, ${skipped.length} skipped, ${failed.length} failed.`);
      if (failed.length > 0) {
        setError(failed
          .map((item) => `${item.skillName}: ${item.message ?? 'Install failed'}`)
          .join('; '));
      }
      await refreshGitHubRateLimit();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus(null);
    } finally {
      setBulkInstalling(false);
    }
  }

  async function handleCheckUpdate() {
    if (!selectedName || !selectedGitHubSource) return;

    setCheckingUpdate(true);
    setError(null);
    setStatus(`Checking updates for ${selectedName}...`);
    try {
      const result = await checkGitHubSkillUpdate(selectedName);
      setUpdateResult(result);
      setLastManualCheckAt(new Date().toISOString());
      setSkillUpdateStatuses((current) => ({
        ...current,
        [selectedName]: { kind: result.updateAvailable ? 'update-available' : 'up-to-date' },
      }));
      const changedCount = result.added.length + result.modified.length + result.removed.length;
      setStatus(result.updateAvailable
        ? `Update available for ${selectedName} (${changedCount} changed files).`
        : `${selectedName} is up to date.`);
      await refreshGitHubRateLimit();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSkillUpdateStatuses((current) => ({
        ...current,
        [selectedName]: { kind: 'check-failed' },
      }));
      setStatus(null);
    } finally {
      setCheckingUpdate(false);
    }
  }

  async function handleRequestForceUpdate() {
    if (!selectedName || !selectedGitHubSource) return;

    setPreparingForceUpdate(true);
    setError(null);
    setStatus(`Preparing force update for ${selectedName}...`);
    try {
      const preview = await previewGitHubSkillForceUpdate(selectedName);
      setForceUpdatePreview(preview);
      setStatus(preview.hasLocalChanges
        ? `Local changes detected for ${selectedName}. Review the confirmation before overwriting.`
        : `No local changes detected for ${selectedName}. Confirm to continue.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus(null);
    } finally {
      setPreparingForceUpdate(false);
    }
  }

  async function handleConfirmForceUpdate() {
    if (!selectedName || !selectedGitHubSource) return;

    setForcingUpdate(true);
    setError(null);
    setStatus(`Updating ${selectedName} from GitHub...`);
    try {
      const result = await forceUpdateGitHubSkill(selectedName);
      await orch.refreshSkills();
      await loadData();
      setSelectedName(result.skillName);
      const markdown = await readUserSkillMarkdown(result.skillName);
      setContent(markdown);
      const source = await readGitHubSkillSourceMetadata(result.skillName);
      setSelectedGitHubSource(source);
      setUpdateResult(null);
      setForceUpdatePreview(null);
      setSkillUpdateStatuses((current) => ({
        ...current,
        [result.skillName]: { kind: 'up-to-date' },
      }));
      const changedCount = result.added.length + result.modified.length + result.removed.length;
      setStatus(changedCount > 0
        ? `Updated ${result.skillName} (${changedCount} changed files, ${result.fileCount} files installed).`
        : `${result.skillName} was already current. Reinstalled ${result.fileCount} files.`);
      await refreshGitHubRateLimit();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus(null);
    } finally {
      setForcingUpdate(false);
    }
  }

  function renderForceUpdateChangeList(title: string, items: string[]) {
    if (items.length === 0) return null;
    const previewItems = items.slice(0, 5);
    return (
      <div>
        <div className="font-medium">{title}: {items.length}</div>
        <div className="opacity-80">
          {previewItems.join(', ')}
          {items.length > previewItems.length ? ', ...' : ''}
        </div>
      </div>
    );
  }

  function renderSkillUpdateBadge(skillName: string) {
    const status = skillUpdateStatuses[skillName];
    if (!status) return null;

    switch (status.kind) {
      case 'manual':
        return <div className="text-[11px] opacity-50 mt-1">manual</div>;
      case 'auto-check-off':
        return <div className="text-[11px] opacity-50 mt-1">auto-check off</div>;
      case 'checking':
        return <div className="text-[11px] text-info mt-1">checking updates...</div>;
      case 'up-to-date':
        return <div className="text-[11px] text-success mt-1">up to date</div>;
      case 'update-available':
        return <div className="text-[11px] text-warning mt-1">update available</div>;
      case 'check-failed':
        return <div className="text-[11px] text-error mt-1">update check failed</div>;
    }
  }

  async function refreshGitHubRateLimit() {
    try {
      const status = await getGitHubRateLimitStatus();
      setGitHubRateLimit(status);
      setGitHubRateLimitError(null);
    } catch (err) {
      setGitHubRateLimitError(err instanceof Error ? err.message : String(err));
    }
  }

  function formatResetAt(resetAt: string | null): string {
    if (!resetAt) return 'unknown';
    return new Date(resetAt).toLocaleTimeString();
  }

  function formatLastManualCheck(value: string | null): string {
    if (!value) return 'never';
    return new Date(value).toLocaleTimeString();
  }

  function closeGitHubCollectionDialog() {
    if (bulkInstalling) return;
    setGitHubCollectionDiscovery(null);
    setGitHubCollectionFilter('');
    setSelectedGitHubCollectionPaths([]);
  }

  function toggleGitHubCollectionSkill(path: string) {
    setSelectedGitHubCollectionPaths((current) => (
      current.includes(path)
        ? current.filter((item) => item !== path)
        : [...current, path]
    ));
  }

  function selectAllGitHubCollectionSkills(skillsToSelect: GitHubDiscoveredSkill[]) {
    setSelectedGitHubCollectionPaths(skillsToSelect
      .filter((skill) => !skill.alreadyInstalled)
      .map((skill) => skill.path));
  }

  return (
    <div className="h-full overflow-hidden p-4 sm:p-6 max-w-6xl mx-auto flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Wrench className="w-5 h-5" /> Skills
        </h2>
        <button className="btn btn-outline btn-sm gap-1.5" onClick={loadData} disabled={loading || !opfsAvailable}>
          <RefreshCw className="w-4 h-4" /> Refresh
        </button>
      </div>

      <div className="card card-bordered bg-base-200">
        <div className="card-body p-4 sm:p-5">
          <div className="space-y-3">
            <div>
              <div className="text-sm font-medium mb-1.5">Install from GitHub</div>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  className="input input-bordered input-sm flex-1"
                  placeholder="https://github.com/owner/repo or https://github.com/owner/repo/tree/main/skills/my-skill"
                  value={githubUrl}
                  onChange={(e) => setGithubUrl(e.target.value)}
                />
                <button
                  className="btn btn-primary btn-sm gap-1.5"
                  onClick={handleInstallFromGitHub}
                  disabled={installing || !githubUrl.trim() || !opfsAvailable}
                >
                  {installing ? <span className="loading loading-spinner loading-xs" /> : <Download className="w-4 h-4" />}
                  {installing ? 'Installing...' : 'Install'}
                </button>
              </div>
              <p className="text-xs opacity-60 mt-2">
                Supports public GitHub skill folders, repositories whose root already contains `SKILL.md`, and parent directories that contain many skills.
              </p>
              <div className="text-xs mt-2 rounded border border-base-300 bg-base-100 px-2 py-2">
                {gitHubRateLimit ? (
                  <span>
                    GitHub API: {gitHubRateLimit.remaining ?? '?'} / {gitHubRateLimit.limit ?? '?'} remaining
                    {' · '}reset {formatResetAt(gitHubRateLimit.resetAt)}
                  </span>
                ) : gitHubRateLimitError ? (
                  <span className="text-error">GitHub API: {gitHubRateLimitError}</span>
                ) : (
                  <span className="opacity-60">Loading GitHub API rate limit...</span>
                )}
              </div>
              {status && <p className="text-xs text-info mt-2">{status}</p>}
            </div>

            <div>
              <div className="text-sm font-medium mb-1.5">Create manually</div>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  className="input input-bordered input-sm flex-1"
                  placeholder="new-skill-name"
                  value={newSkillName}
                  onChange={(e) => setNewSkillName(e.target.value)}
                />
                <button
                  className="btn btn-outline btn-sm gap-1.5"
                  onClick={handleCreateSkill}
                  disabled={creating || !newSkillName.trim() || !opfsAvailable}
                >
                  <Plus className="w-4 h-4" /> New Skill
                </button>
              </div>
              <p className="text-xs opacity-60 mt-2">
                Manual scaffold creates: <code>SKILL.md</code>, <code>scripts/.gitkeep</code>, <code>references/.gitkeep</code>, <code>assets/.gitkeep</code>.
              </p>
            </div>
          </div>
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
              <p className="text-sm opacity-60">
                {opfsAvailable ? 'No user skills yet.' : 'User skills require Origin Private File System support.'}
              </p>
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
                    {renderSkillUpdateBadge(skill.name)}
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
                    {selectedGitHubSource && (
                      <div className="text-xs opacity-60 mt-1 truncate">
                        GitHub: {selectedGitHubSource.owner}/{selectedGitHubSource.repo}@{selectedGitHubSource.ref}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap justify-end">
                    {selectedGitHubSource && (
                      <>
                        <button
                          className="btn btn-outline btn-sm gap-1.5"
                          onClick={handleCheckUpdate}
                          disabled={checkingUpdate || forcingUpdate}
                        >
                          {checkingUpdate ? <span className="loading loading-spinner loading-xs" /> : <RefreshCw className="w-4 h-4" />}
                          {checkingUpdate ? 'Checking...' : 'Check update'}
                        </button>
                        <button
                          className="btn btn-outline btn-sm gap-1.5"
                          onClick={handleRequestForceUpdate}
                          disabled={preparingForceUpdate || forcingUpdate || checkingUpdate}
                        >
                          {(preparingForceUpdate || forcingUpdate) ? <span className="loading loading-spinner loading-xs" /> : <Download className="w-4 h-4" />}
                          {preparingForceUpdate ? 'Preparing...' : forcingUpdate ? 'Updating...' : 'Force update'}
                        </button>
                      </>
                    )}
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

                {selectedGitHubSource && updateResult && (
                  <div className={`mb-2 rounded border px-3 py-2 text-xs ${updateResult.updateAvailable ? 'border-warning/40 bg-warning/10' : 'border-success/40 bg-success/10'}`}>
                    {updateResult.updateAvailable
                      ? `Update available: +${updateResult.added.length} added, ~${updateResult.modified.length} modified, -${updateResult.removed.length} removed.`
                      : 'This GitHub skill is up to date.'}
                    <div className="mt-1 opacity-70">
                      Last manual check: {formatLastManualCheck(lastManualCheckAt)}
                    </div>
                  </div>
                )}

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

      {forceUpdatePreview && (
        <dialog className="modal modal-open">
          <div className="modal-box max-w-lg">
            <h3 className="font-bold text-lg">Force update skill?</h3>
            <p className="py-3 text-sm">
              This will overwrite the local files for <strong>{forceUpdatePreview.skillName}</strong> with the current GitHub version.
            </p>
            {forceUpdatePreview.hasLocalChanges ? (
              <div className="mb-4 rounded border border-warning/40 bg-warning/10 px-3 py-3 text-sm">
                <div className="font-medium mb-2">Local changes will be lost if you continue.</div>
                <div className="space-y-2 text-xs">
                  {renderForceUpdateChangeList('Modified', forceUpdatePreview.localChanges.modified)}
                  {renderForceUpdateChangeList('Missing', forceUpdatePreview.localChanges.missing)}
                  {renderForceUpdateChangeList('Untracked', forceUpdatePreview.localChanges.untracked)}
                </div>
              </div>
            ) : (
              <div className="mb-4 rounded border border-base-300 bg-base-100 px-3 py-3 text-sm">
                No local file changes were detected.
              </div>
            )}
            <div className="modal-action">
              <button className="btn btn-ghost" onClick={() => setForceUpdatePreview(null)} disabled={forcingUpdate}>
                Cancel
              </button>
              <button className="btn btn-warning" onClick={handleConfirmForceUpdate} disabled={forcingUpdate}>
                {forcingUpdate ? 'Updating...' : 'Overwrite from GitHub'}
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button onClick={() => setForceUpdatePreview(null)}>close</button>
          </form>
        </dialog>
      )}

      {gitHubCollectionDiscovery && (
        <dialog className="modal modal-open">
          <div className="modal-box max-w-3xl">
            <h3 className="font-bold text-lg">Select skills to install</h3>
            <p className="py-2 text-sm opacity-80 break-all">
              {gitHubCollectionDiscovery.owner}/{gitHubCollectionDiscovery.repo}@{gitHubCollectionDiscovery.ref}
              {gitHubCollectionDiscovery.path ? `/${gitHubCollectionDiscovery.path}` : ''}
            </p>
            <div className="flex flex-col gap-3">
              {gitHubCollectionDiscovery.warnings.length > 0 && (
                <div className="rounded border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
                  Some directories could not be checked: {gitHubCollectionDiscovery.warnings.join('; ')}
                </div>
              )}
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="text"
                  className="input input-bordered input-sm flex-1"
                  placeholder="Filter discovered skills"
                  value={gitHubCollectionFilter}
                  onChange={(e) => setGitHubCollectionFilter(e.target.value)}
                />
                <button
                  className="btn btn-outline btn-sm"
                  onClick={() => selectAllGitHubCollectionSkills(filteredGitHubCollectionSkills)}
                  disabled={bulkInstalling || filteredGitHubCollectionSkills.every((skill) => skill.alreadyInstalled)}
                >
                  Select all
                </button>
                <button
                  className="btn btn-outline btn-sm"
                  onClick={() => setSelectedGitHubCollectionPaths([])}
                  disabled={bulkInstalling || selectedGitHubCollectionPaths.length === 0}
                >
                  Clear all
                </button>
              </div>
              <div className="max-h-[420px] overflow-y-auto rounded border border-base-300 bg-base-100">
                {filteredGitHubCollectionSkills.length === 0 ? (
                  <div className="px-3 py-6 text-sm opacity-60">No skills match the current filter.</div>
                ) : (
                  <div className="divide-y divide-base-300">
                    {filteredGitHubCollectionSkills.map((skill) => {
                      const checked = selectedGitHubCollectionPaths.includes(skill.path);
                      return (
                        <label
                          key={skill.path}
                          className={`flex items-start gap-3 px-3 py-3 ${skill.alreadyInstalled ? 'opacity-60' : 'cursor-pointer'}`}
                        >
                          <input
                            type="checkbox"
                            className="checkbox checkbox-sm mt-0.5"
                            checked={checked}
                            disabled={bulkInstalling || skill.alreadyInstalled}
                            onChange={() => toggleGitHubCollectionSkill(skill.path)}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <div className="font-medium text-sm">{skill.skillName}</div>
                              {skill.alreadyInstalled && (
                                <span className="badge badge-outline badge-sm">Installed</span>
                              )}
                            </div>
                            <div className="text-xs opacity-70 mt-1 break-all">{skill.path}</div>
                            <div className="text-xs opacity-80 mt-1">
                              {skill.description || 'No description provided.'}
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
            <div className="modal-action">
              <button className="btn btn-ghost" onClick={closeGitHubCollectionDialog} disabled={bulkInstalling}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleInstallSelectedGitHubSkills}
                disabled={bulkInstalling || selectedGitHubCollectionPaths.length === 0}
              >
                {bulkInstalling ? 'Installing...' : `Install selected (${selectedGitHubCollectionPaths.length})`}
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button onClick={closeGitHubCollectionDialog}>close</button>
          </form>
        </dialog>
      )}
    </div>
  );
}
