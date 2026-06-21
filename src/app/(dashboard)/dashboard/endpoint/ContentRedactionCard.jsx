"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Card, Button, Toggle, Badge, Input, Modal, SegmentedControl } from "@/shared/components";
import { cn } from "@/shared/utils/cn";

// ── Helpers ───────────────────────────────────────────────────────

function generateId() {
  return `rule_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Apply all matching rules to text (mirrors server-side redactText logic).
 * Rules are applied sequentially in array order, matching the engine behavior.
 */
function previewRedactAll(text, rules, scope) {
  if (!text) return text;
  let result = text;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.scope !== scope && rule.scope !== "both") continue;
    if (!rule.pattern) continue;
    try {
      const flags = "g" + (rule.caseSensitive ? "" : "i");
      const source = rule.isRegex ? rule.pattern : escapeRegex(rule.pattern);
      const regex = new RegExp(source, flags);
      result = result.replace(regex, rule.replacement || "[REDACTED]");
    } catch {
      // invalid regex — skip this rule
    }
  }
  return result;
}

/** Validate a rule's regex (client-side) */
function validateRegex(rule) {
  if (!rule.pattern) return { valid: false, error: "Pattern is required" };
  if (rule.isRegex) {
    try {
      new RegExp(rule.pattern, "g" + (rule.caseSensitive ? "" : "i"));
      return { valid: true };
    } catch (err) {
      return { valid: false, error: err.message };
    }
  }
  return { valid: true };
}

const SCOPE_OPTIONS = [
  { value: "errors", label: "Errors" },
  { value: "responses", label: "Responses" },
  { value: "both", label: "Both" },
];

const SCOPE_BADGE = {
  errors: { variant: "error", label: "Errors" },
  responses: { variant: "info", label: "Responses" },
  both: { variant: "primary", label: "Both" },
};

const EMPTY_RULE = {
  id: "",
  name: "",
  pattern: "",
  isRegex: false,
  replacement: "[REDACTED]",
  scope: "both",
  caseSensitive: false,
  enabled: true,
};

// ── Rule Edit Modal ───────────────────────────────────────────────

function RuleEditModal({ isOpen, onClose, rule, allRules, onSave }) {
  const [draft, setDraft] = useState(rule || EMPTY_RULE);
  const [testInput, setTestInput] = useState("");
  const [showUnsavedWarning, setShowUnsavedWarning] = useState(false);

  useEffect(() => {
    const fresh = rule ? { ...rule } : { ...EMPTY_RULE, id: generateId() };
    setDraft(fresh);
    setTestInput("");
    setShowUnsavedWarning(false);
  }, [rule, isOpen]);

  const validation = useMemo(() => validateRegex(draft), [draft]);

  const testOutput = useMemo(() => {
    if (!testInput) return "";
    // Build the effective rule list: all active rules (excluding the one being
    // edited if it exists) plus the current draft version of this rule.
    const otherRules = (allRules || []).filter((r) => r.id !== draft.id);
    const effectiveRules = [...otherRules, { ...draft, enabled: true }];
    return previewRedactAll(testInput, effectiveRules, draft.scope === "both" ? "responses" : draft.scope);
  }, [testInput, draft, allRules]);

  const handleSave = () => {
    if (!draft.name.trim()) return;
    if (!validation.valid) return;
    onSave({ ...draft });
  };

  const hasUnsavedChanges = useMemo(() => {
    const original = rule || EMPTY_RULE;
    return Object.keys(draft).some(
      (k) => draft[k] !== original[k]
    );
  }, [draft, rule]);

  const attemptClose = () => {
    if (hasUnsavedChanges) {
      setShowUnsavedWarning(true);
    } else {
      onClose();
    }
  };

  const update = (field, value) => {
    setDraft((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={attemptClose}
      title={rule ? "Edit Rule" : "Add Rule"}
      size="full"
      footer={
        <>
          <Button variant="ghost" onClick={attemptClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={handleSave}
            disabled={!draft.name.trim() || !draft.pattern || !validation.valid}
          >
            Save Rule
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {/* Rule name */}
        <Input
          label="Rule Name"
          placeholder="e.g. Hide Tencent"
          value={draft.name}
          onChange={(e) => update("name", e.target.value)}
          required
        />

        {/* Pattern mode */}
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-text-main">Match Type</label>
          <SegmentedControl
            size="sm"
            value={draft.isRegex ? "regex" : "text"}
            onChange={(v) => update("isRegex", v === "regex")}
            options={[
              { value: "text", label: "Plain Text" },
              { value: "regex", label: "Regex" },
            ]}
          />
        </div>

        {/* Pattern */}
        <Input
          label="Pattern"
          placeholder={draft.isRegex ? "e.g. \\btencent\\b" : "e.g. tencent"}
          value={draft.pattern}
          onChange={(e) => update("pattern", e.target.value)}
          error={draft.pattern && !validation.valid ? validation.error : ""}
          hint={draft.isRegex ? "Regular expression pattern" : "Exact text to find (case-insensitive by default)"}
          required
        />

        {/* Replacement */}
        <Input
          label="Replacement"
          placeholder="e.g. [Provider]"
          value={draft.replacement}
          onChange={(e) => update("replacement", e.target.value)}
          hint="Text to replace matches with"
        />

        {/* Scope */}
        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium text-text-main">Scope</label>
          <SegmentedControl
            size="sm"
            value={draft.scope}
            onChange={(v) => update("scope", v)}
            options={SCOPE_OPTIONS}
          />
          <p className="text-xs text-text-muted">
            Where this rule applies — error messages, response content, or both
          </p>
        </div>

        {/* Case sensitive */}
        <div className="flex items-center justify-between p-3 rounded-lg bg-bg border border-border-subtle">
          <div>
            <p className="font-medium text-sm">Case Sensitive</p>
            <p className="text-xs text-text-muted">Match pattern exactly as written</p>
          </div>
          <Toggle
            checked={draft.caseSensitive}
            onChange={(v) => update("caseSensitive", v)}
            size="sm"
          />
        </div>

        {/* Live test preview */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium text-text-main">Test Preview</label>
            <span className="text-[10px] text-text-muted px-2 py-0.5 rounded-full bg-surface-2">
              All active rules in scope are applied
            </span>
          </div>
          <p className="text-xs text-text-muted">
            Type sample text to see how all matching rules would redact it
          </p>
          <textarea
            className="w-full py-2.5 px-3 text-sm text-text-main bg-surface-2 rounded-[10px] border border-transparent placeholder-text-muted/70 focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-500/40 transition-all duration-150 ease-out text-[16px] sm:text-sm min-h-[60px] resize-y"
            placeholder="Type sample text to test..."
            value={testInput}
            onChange={(e) => setTestInput(e.target.value)}
          />
          {testInput && (
            <div className="p-3 rounded-[10px] bg-bg border border-border-subtle">
              <p className="text-xs text-text-muted mb-1.5 font-medium">Result:</p>
              <p className="text-sm font-mono text-text-main whitespace-pre-wrap break-all">
                {testOutput || <span className="text-text-muted italic">(no matches)</span>}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Unsaved changes confirmation */}
      <Modal
        isOpen={showUnsavedWarning}
        onClose={() => setShowUnsavedWarning(false)}
        title="Unsaved Changes"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowUnsavedWarning(false)}>
              Keep Editing
            </Button>
            <Button variant="danger" onClick={onClose}>
              Discard & Close
            </Button>
          </>
        }
      >
        <p className="text-text-muted">
          You have unsaved changes. Are you sure you want to close without saving?
        </p>
      </Modal>
    </Modal>
  );
}

// ── Rule Card ─────────────────────────────────────────────────────

function RuleCard({ rule, onToggle, onEdit, onDelete, disabled }) {
  const scopeBadge = SCOPE_BADGE[rule.scope] || SCOPE_BADGE.both;

  return (
    <div className={cn(
      "flex items-center gap-3 p-3 rounded-lg bg-bg border border-border-subtle transition-colors group",
      !disabled && "hover:border-brand-500/30",
      disabled && "opacity-60"
    )}>
      <Toggle
        checked={rule.enabled}
        onChange={() => onToggle(rule.id)}
        size="sm"
        disabled={disabled}
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm text-text-main truncate">{rule.name}</span>
          <Badge variant={scopeBadge.variant} size="sm">
            {scopeBadge.label}
          </Badge>
          {rule.isRegex && (
            <Badge variant="default" size="sm">Regex</Badge>
          )}
          {rule.caseSensitive && (
            <Badge variant="warning" size="sm">Aa</Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-1 text-xs text-text-muted font-mono truncate">
          {rule.isRegex ? (
            <span className="truncate">/{rule.pattern}/</span>
          ) : (
            <span className="truncate">&quot;{rule.pattern}&quot;</span>
          )}
          <span className="shrink-0">→</span>
          <span className="truncate text-brand-600 dark:text-brand-300">{rule.replacement}</span>
        </div>
      </div>
      {!disabled && (
        <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => onEdit(rule)}
            className="p-1.5 rounded-lg text-text-muted hover:bg-surface-2 hover:text-text-main transition-colors"
            title="Edit"
          >
            <span className="material-symbols-outlined text-[18px]">edit</span>
          </button>
          <button
            onClick={() => onDelete(rule)}
            className="p-1.5 rounded-lg text-text-muted hover:bg-red-500/10 hover:text-red-500 transition-colors"
            title="Delete"
          >
            <span className="material-symbols-outlined text-[18px]">delete</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────

export default function ContentRedactionCard() {
  const [config, setConfig] = useState({ enabled: false, rules: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editingRule, setEditingRule] = useState(null);
  const [deleteRule, setDeleteRule] = useState(null);
  const [status, setStatus] = useState({ type: "", message: "" });
  const statusTimerRef = useRef(null);
  const saveSeqRef = useRef(0);

  // Clear status timer on unmount
  useEffect(() => {
    return () => {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    };
  }, []);

  // Load config from API
  const loadConfig = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/content-redaction");
      if (res.ok) {
        const data = await res.json();
        setConfig(data);
        setLoadError(false);
      } else {
        setLoadError(true);
      }
    } catch (err) {
      console.error("Failed to load content redaction config:", err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // Save config to API with optimistic update + rollback
  const saveConfig = useCallback(async (newConfig, prevConfig) => {
    const seq = ++saveSeqRef.current;
    setSaving(true);

    // Optimistic update
    setConfig(newConfig);

    // Clear any existing status timer
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);

    try {
      const res = await fetch("/api/settings/content-redaction", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newConfig),
      });

      // If a newer save has been initiated, discard this response
      if (seq !== saveSeqRef.current) return;

      if (res.ok) {
        const saved = await res.json();
        setConfig(saved);
        setStatus({ type: "success", message: "Settings saved" });
      } else {
        // Rollback on error
        if (prevConfig) setConfig(prevConfig);
        const data = await res.json().catch(() => ({}));
        setStatus({ type: "error", message: data.error || "Failed to save" });
      }
    } catch (err) {
      if (seq !== saveSeqRef.current) return;
      // Rollback on network error
      if (prevConfig) setConfig(prevConfig);
      setStatus({ type: "error", message: "Failed to save — network error" });
    } finally {
      if (seq === saveSeqRef.current) {
        setSaving(false);
      }
      // Auto-clear status after 3s
      statusTimerRef.current = setTimeout(() => {
        setStatus({ type: "", message: "" });
      }, 3000);
    }
  }, []);

  // ── Handlers ──

  const handleToggleEnabled = (enabled) => {
    if (saving) return;
    const newConfig = { ...config, enabled };
    saveConfig(newConfig, config);
  };

  const handleAddRule = () => {
    setEditingRule(null);
    setShowModal(true);
  };

  const handleEditRule = (rule) => {
    setEditingRule(rule);
    setShowModal(true);
  };

  const handleSaveRule = (rule) => {
    const existingIdx = config.rules.findIndex((r) => r.id === rule.id);
    let newRules;
    if (existingIdx >= 0) {
      newRules = config.rules.map((r) => (r.id === rule.id ? rule : r));
    } else {
      newRules = [...config.rules, rule];
    }
    const newConfig = { ...config, rules: newRules };
    setShowModal(false);
    saveConfig(newConfig, config);
  };

  const handleDeleteRule = (rule) => {
    setDeleteRule(rule);
  };

  const confirmDelete = () => {
    if (!deleteRule) return;
    const newRules = config.rules.filter((r) => r.id !== deleteRule.id);
    const newConfig = { ...config, rules: newRules };
    setDeleteRule(null);
    saveConfig(newConfig, config);
  };

  const handleToggleRule = (ruleId) => {
    if (saving) return;
    const newRules = config.rules.map((r) =>
      r.id === ruleId ? { ...r, enabled: !r.enabled } : r
    );
    const newConfig = { ...config, rules: newRules };
    saveConfig(newConfig, config);
  };

  // ── Stats ──

  const stats = useMemo(() => {
    const total = config.rules.length;
    const active = config.rules.filter((r) => r.enabled).length;
    const errorRules = config.rules.filter(
      (r) => r.enabled && (r.scope === "errors" || r.scope === "both")
    ).length;
    const responseRules = config.rules.filter(
      (r) => r.enabled && (r.scope === "responses" || r.scope === "both")
    ).length;
    return { total, active, errorRules, responseRules };
  }, [config.rules]);

  return (
    <>
      <Card id="content-redaction">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="material-symbols-outlined text-primary">shield</span>
            Content Redaction
          </h2>
          <Toggle
            checked={config.enabled}
            onChange={handleToggleEnabled}
            disabled={loading || saving}
          />
        </div>
        <p className="text-sm text-text-muted mb-4">
          Scrub sensitive words or phrases from error messages and LLM responses before they reach the client
        </p>

        {/* Load error */}
        {loadError && !loading && (
          <div className="mb-4 p-3 rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 text-sm flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-[18px]">error</span>
              Failed to load redaction settings
            </div>
            <Button variant="ghost" size="sm" onClick={loadConfig} icon="refresh">
              Retry
            </Button>
          </div>
        )}

        {/* Saving indicator */}
        {saving && (
          <div className="mb-4 p-2 rounded-lg bg-surface-2 text-sm flex items-center gap-2 text-text-muted">
            <span className="material-symbols-outlined text-[16px] animate-spin">progress_activity</span>
            Saving...
          </div>
        )}

        {/* Status message */}
        {status.message && !saving && (
          <div
            className={cn(
              "mb-4 p-2.5 rounded-lg text-sm flex items-center gap-2",
              status.type === "success"
                ? "bg-green-500/10 text-green-600 dark:text-green-400"
                : "bg-red-500/10 text-red-600 dark:text-red-400"
            )}
          >
            <span className="material-symbols-outlined text-[18px]">
              {status.type === "success" ? "check_circle" : "error"}
            </span>
            {status.message}
          </div>
        )}

        {config.enabled && !loadError && (
          <>
            {/* Stats row */}
            <div className="flex items-center gap-4 mb-4 pb-4 border-b border-border-subtle flex-wrap">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-text-muted">Total:</span>
                <Badge variant="default" size="sm">{stats.total}</Badge>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-text-muted">Active:</span>
                <Badge variant="success" size="sm" dot>{stats.active}</Badge>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-text-muted">Errors:</span>
                <Badge variant="error" size="sm">{stats.errorRules}</Badge>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-text-muted">Responses:</span>
                <Badge variant="info" size="sm">{stats.responseRules}</Badge>
              </div>
            </div>

            {/* Add Rule button */}
            <div className="mb-3">
              <Button
                variant="secondary"
                size="sm"
                icon="add"
                onClick={handleAddRule}
                disabled={saving}
              >
                Add Rule
              </Button>
            </div>

            {/* Rule list */}
            {config.rules.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <span className="material-symbols-outlined text-[32px] text-text-muted mb-2">
                  filter_alt_off
                </span>
                <p className="text-sm text-text-muted">No rules configured</p>
                <p className="text-xs text-text-muted mt-1">
                  Add a rule to start redacting content
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {config.rules.map((rule) => (
                  <RuleCard
                    key={rule.id}
                    rule={rule}
                    onToggle={handleToggleRule}
                    onEdit={handleEditRule}
                    onDelete={handleDeleteRule}
                    disabled={saving}
                  />
                ))}
              </div>
            )}
          </>
        )}

        {loading && (
          <div className="flex items-center justify-center py-4">
            <span className="material-symbols-outlined animate-spin text-text-muted">progress_activity</span>
          </div>
        )}
      </Card>

      {/* Edit/Add Modal */}
      <RuleEditModal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        rule={editingRule}
        allRules={config.rules}
        onSave={handleSaveRule}
      />

      {/* Delete Confirmation */}
      <Modal
        isOpen={!!deleteRule}
        onClose={() => setDeleteRule(null)}
        title="Delete Rule"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteRule(null)}>Cancel</Button>
            <Button variant="danger" onClick={confirmDelete}>Delete</Button>
          </>
        }
      >
        <p className="text-text-muted">
          Are you sure you want to delete{" "}
          <span className="font-medium text-text-main">&ldquo;{deleteRule?.name}&rdquo;</span>?
        </p>
      </Modal>
    </>
  );
}
