export const styles = `
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-sideBar-background);
}
#root { display: flex; flex-direction: column; height: 100vh; }

.app { display: flex; flex-direction: column; height: 100vh; }

.header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--vscode-panel-border);
  flex-shrink: 0;
}
.header select {
  flex: 1;
  min-width: 0;
  background: var(--vscode-dropdown-background);
  color: var(--vscode-dropdown-foreground);
  border: 1px solid var(--vscode-dropdown-border);
  border-radius: 2px;
  padding: 2px 4px;
  font-size: inherit;
}
.status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.status-dot.connected { background: var(--vscode-testing-iconPassed, #2ea043); }
.status-dot.disconnected { background: var(--vscode-testing-iconFailed, #f85149); }

.icon-button {
  background: transparent;
  color: var(--vscode-foreground);
  border: none;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 3px;
  font-size: inherit;
}
.icon-button:hover { background: var(--vscode-toolbar-hoverBackground); }

.transcript { flex: 1; overflow-y: auto; padding: 8px; }

.message { margin-bottom: 10px; line-height: 1.5; }
.message.user {
  background: var(--vscode-input-background);
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  padding: 6px 10px;
  white-space: pre-wrap;
  word-break: break-word;
}
.message.assistant { padding: 0 2px; word-break: break-word; }
.message.assistant pre {
  background: var(--vscode-textCodeBlock-background);
  padding: 8px;
  border-radius: 4px;
  overflow-x: auto;
}
.message.assistant code {
  background: var(--vscode-textCodeBlock-background);
  padding: 1px 4px;
  border-radius: 3px;
  font-family: var(--vscode-editor-font-family);
  font-size: 0.95em;
}
.message.assistant pre code { padding: 0; background: transparent; }
.message.assistant p:first-child { margin-top: 0; }
.message.assistant p:last-child { margin-bottom: 0; }

.message.notice {
  color: var(--vscode-descriptionForeground);
  font-style: italic;
  font-size: 0.95em;
}
.message.error {
  color: var(--vscode-errorForeground);
  border: 1px solid var(--vscode-errorForeground);
  border-radius: 4px;
  padding: 6px 10px;
  white-space: pre-wrap;
  word-break: break-word;
}

.tool-card, .approval-card {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  margin-bottom: 10px;
  font-size: 0.95em;
  overflow: hidden;
}
.tool-card summary, .approval-card .approval-title {
  padding: 5px 10px;
  cursor: pointer;
  background: var(--vscode-editorWidget-background);
  display: flex;
  align-items: center;
  gap: 6px;
}
.tool-card summary { list-style: none; }
.tool-card summary::-webkit-details-marker { display: none; }
.tool-name { font-weight: 600; font-family: var(--vscode-editor-font-family); }
.tool-status { color: var(--vscode-descriptionForeground); margin-left: auto; flex-shrink: 0; }
.tool-body {
  padding: 6px 10px;
  border-top: 1px solid var(--vscode-panel-border);
}
.tool-body pre {
  margin: 4px 0;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow-y: auto;
  font-family: var(--vscode-editor-font-family);
  font-size: 0.95em;
}

.approval-card { border-color: var(--vscode-inputValidation-warningBorder, #d29922); }
.approval-title { font-weight: 600; }
.approval-body { padding: 6px 10px; }
.approval-body pre.diff, .approval-body pre.command {
  margin: 4px 0;
  padding: 6px;
  background: var(--vscode-textCodeBlock-background);
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 260px;
  overflow-y: auto;
  font-family: var(--vscode-editor-font-family);
  font-size: 0.95em;
}
.diff-add { color: var(--vscode-gitDecoration-addedResourceForeground, #2ea043); }
.diff-del { color: var(--vscode-gitDecoration-deletedResourceForeground, #f85149); }
.approval-actions { display: flex; gap: 6px; padding: 0 10px 8px; }
.approval-resolved { padding: 0 10px 8px; color: var(--vscode-descriptionForeground); font-style: italic; }

.button {
  border: none;
  border-radius: 3px;
  padding: 4px 12px;
  cursor: pointer;
  font-size: inherit;
}
.button.primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
}
.button.primary:hover { background: var(--vscode-button-hoverBackground); }
.button.secondary {
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
}
.button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
.button:disabled { opacity: 0.5; cursor: default; }

.composer {
  flex-shrink: 0;
  border-top: 1px solid var(--vscode-panel-border);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.composer textarea {
  width: 100%;
  resize: vertical;
  min-height: 52px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
  border-radius: 4px;
  padding: 6px 8px;
  font-family: inherit;
  font-size: inherit;
}
.composer textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
.composer-row { display: flex; align-items: center; gap: 8px; }
.composer-row label {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
  cursor: pointer;
}
.composer-row .spacer { flex: 1; }

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--vscode-descriptionForeground);
  text-align: center;
  padding: 0 16px;
  gap: 8px;
}
.error-banner {
  margin: 8px;
  padding: 8px 10px;
  border: 1px solid var(--vscode-inputValidation-errorBorder, #f85149);
  background: var(--vscode-inputValidation-errorBackground, transparent);
  border-radius: 4px;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.95em;
}
.thinking {
  color: var(--vscode-descriptionForeground);
  font-style: italic;
  margin-bottom: 10px;
}
`;
