import * as vscode from 'vscode';
import type { SwageClient } from '../../client/client';
import { type Decision, ModelRouter, RecoveryMonitor } from '../fallback';
import { probeProfile } from '../probe';
import { profilesFrom, type ResolvedProfile } from '../profiles';

/**
 * Model profiles in VS Code (blueprint sections 3 and 8, F6 and F9): the router shared by agent
 * mode and inline edit, a status bar item naming the active profile, "Swage: Switch Model", the
 * fallback toast, and the offer to switch back when a failed profile answers again. Profiles
 * come from `swage.models` (or a development checkout's config/models.yaml) and are re-read when
 * the setting changes, so the organisers can swap the primary model at any time.
 */

export class ModelsController implements vscode.Disposable {
  private routerValue: ModelRouter | undefined;
  private error: string | undefined;
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private routerSub: { dispose(): void } | undefined;
  private recovery: RecoveryMonitor | undefined;
  private client: SwageClient | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 999);
    this.item.name = 'Swage model';
    this.item.command = 'swage.switchModel';
    this.disposables.push(
      this.item,
      vscode.commands.registerCommand('swage.switchModel', () => this.pick()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('swage.models')) this.load();
      }),
    );
    this.load();
  }

  /** The router, or undefined while the profiles are missing or invalid. */
  get router(): ModelRouter | undefined {
    return this.routerValue;
  }

  /** Why there is no router, for error messages. */
  get problem(): string | undefined {
    return this.error;
  }

  private load(): void {
    try {
      const profiles = profilesFrom(
        vscode.workspace.getConfiguration('swage').get<unknown>('models', []),
        this.context.extensionPath,
      );
      this.error = undefined;
      if (this.routerValue) this.routerValue.setProfiles(profiles);
      else {
        this.routerValue = new ModelRouter(profiles);
        this.routerSub = this.routerValue.onDidChange(() => this.refresh());
        if (this.client) this.attach(this.client);
      }
    } catch (err) {
      this.error = (err as Error).message;
    }
    this.refresh();
  }

  private refresh(): void {
    const router = this.routerValue;
    if (!router) {
      this.item.text = '$(error) Swage: no model';
      this.item.tooltip = this.error ?? 'No model profile';
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      this.item.show();
      return;
    }
    const active = router.active;
    const onFallback = active.name !== router.primary.name;
    this.item.text = `${onFallback ? '$(warning)' : '$(hubot)'} Swage: ${active.label}`;
    this.item.backgroundColor = onFallback
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    const tip = new vscode.MarkdownString(undefined, true);
    tip.appendMarkdown(
      `**${active.label}** · profile \`${active.name}\` · \`${active.trueforgeModel}\`\n\n`,
    );
    const t = active.timeouts;
    tip.appendMarkdown(
      `${active.kind} · first token ${t.firstTokenMs / 1000} s · stall ${t.stallMs / 1000} s\n\n`,
    );
    for (const p of router.profiles) {
      const f = router.lastFailure(p.name);
      if (f) tip.appendMarkdown(`$(warning) ${p.label} ${f.failure.reason}\n\n`);
    }
    tip.appendMarkdown('Click to switch model.');
    this.item.tooltip = tip;
    this.item.show();
  }

  /** The TrueForge client is ready: recovery probes can run. */
  attach(client: SwageClient): void {
    this.client = client;
    const router = this.routerValue;
    if (!router) return;
    this.recovery?.dispose();
    this.recovery = new RecoveryMonitor({
      router,
      probe: (p) => probeProfile(client, p).then((r) => r.ok),
    });
    this.recovery.onRecovered((p) => void this.offerSwitchBack(p));
  }

  private async offerSwitchBack(p: ResolvedProfile): Promise<void> {
    const choice = await vscode.window.showInformationMessage(
      `${p.label} is answering again. Switch back to it?`,
      'Switch back',
    );
    if (choice === 'Switch back') this.routerValue?.setActive(p.name);
  }

  /** A run fell back (no user action needed): say so, with a way to choose another model. */
  notifySwitch(decision: Extract<Decision, { action: 'switch' }>): void {
    void vscode.window.showWarningMessage(decision.message, 'Switch model').then((choice) => {
      if (choice === 'Switch model') void this.pick();
    });
  }

  /** "Swage: Switch Model": pick the profile for the next request, or change the primary. */
  async pick(): Promise<string | undefined> {
    const router = this.routerValue;
    if (!router) {
      void vscode.window.showErrorMessage(`Swage: ${this.error ?? 'no model profile'}`);
      return undefined;
    }
    type Item = vscode.QuickPickItem & { action: string };
    const items: Item[] = router.profiles.map((p) => {
      const f = router.lastFailure(p.name);
      return {
        action: `use:${p.name}`,
        label: `${p.name === router.active.name ? '$(check) ' : ''}${p.label}`,
        description: `${p.name} · ${p.trueforgeModel}`,
        detail: f
          ? `$(warning) ${p.label} ${f.failure.reason}`
          : `${p.kind}, first token ${p.timeouts.firstTokenMs / 1000} s`,
      };
    });
    items.push(
      { action: '', label: '', kind: vscode.QuickPickItemKind.Separator },
      {
        action: 'primary',
        label: '$(edit) Change the primary model…',
        detail:
          'Any model configured in TrueForge (Settings, Models), including an OpenAI-compatible endpoint',
      },
      { action: 'settings', label: '$(gear) Edit the profiles (swage.models)' },
    );
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Swage: Switch Model',
      placeHolder: `Active: ${router.active.label} (${router.active.trueforgeModel})`,
    });
    if (!picked) return undefined;
    if (picked.action.startsWith('use:')) {
      const name = picked.action.slice(4);
      router.setActive(name);
      void vscode.window.setStatusBarMessage(
        `Swage will use ${router.active.label} for the next request.`,
        4000,
      );
      return name;
    }
    if (picked.action === 'settings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'swage.models');
      return undefined;
    }
    return this.changePrimary();
  }

  /** Writes a new primary model into swage.models (where it is defined), keeping the fallbacks. */
  private async changePrimary(): Promise<string | undefined> {
    const router = this.routerValue;
    if (!router) return undefined;
    const models = await this.client?.listModels().catch(() => undefined);
    const model = models
      ? (
          await vscode.window.showQuickPick(
            models.map((m) => ({
              label: m,
              description: m === router.primary.trueforgeModel ? 'current primary' : '',
            })),
            { title: 'Primary model (from TrueForge)' },
          )
        )?.label
      : await vscode.window.showInputBox({
          title: 'Primary model',
          prompt:
            'TrueForge model, as provider/model (TrueForge is not started yet, so it cannot be listed)',
          value: router.primary.trueforgeModel,
          validateInput: (v) => (/^[^/\s]+\/\S+$/.test(v) ? undefined : 'Use provider/model'),
        });
    if (!model) return undefined;
    const config = vscode.workspace.getConfiguration('swage');
    const inspect = config.inspect<unknown[]>('models');
    const target =
      inspect?.workspaceValue && inspect.workspaceValue.length > 0
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    const list = router.profiles.map((p) => ({
      name: p.name,
      kind: p.kind,
      trueforgeModel: p.trueforgeModel,
      ...(p.params ? { params: p.params } : {}),
      timeouts: p.timeouts,
      label: p.label,
    }));
    const [first, ...rest] = list;
    if (!first) return undefined;
    // A new model gets its own label, from its provider.
    const { label: _old, ...firstWithoutLabel } = first;
    void _old;
    await config.update(
      'models',
      [{ ...firstWithoutLabel, trueforgeModel: model }, ...rest],
      target,
    );
    router.setActive(router.primary.name);
    void vscode.window.showInformationMessage(`Swage's primary model is now ${model}.`);
    return model;
  }

  dispose(): void {
    this.recovery?.dispose();
    this.routerSub?.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
