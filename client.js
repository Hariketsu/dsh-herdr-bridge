// dsh-herdr-bridge, browser half: this plugin's settings, shown on its own page under Plugins.
// Hand-written in the client module system's lazy-CJS factory format (the format DSH's own tsdown
// preset emits), so the package needs no build. It edits the volatile fields of the plugin's
// Config (`herdrPlacement`, `herdrSpace`) through the Host's settings form for the `herdr-bridge`
// profile entry; the Host validates and persists them, and the plugin reads them live.
window.__ModuleLoader__.load({
	id: "dsh-herdr-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const { createElement: h, useId } = require("react");
		const { Button, SettingsForm, SettingsFormModel, SettingsValueField, Tag, settingsTextField } = require("@deepseek-ai/dsh-client-ui-primitives");

		/** Dictionary namespace owned by this page. */
		const NS = "herdrBridge";
		/** Settings namespace: the plugin's profile entry id. */
		const SETTINGS = "herdr-bridge";
		/** Plugins page key of this bundle: its package name. */
		const BUNDLE = "dsh-herdr-bridge";
		const PLACEMENTS = ["folder", "dsh", "none"];

		const en = {
			placement: "Where Herdr App shows sessions started in DSH",
			folder: "By folder",
			folderHint: "A session joins the Herdr App space that already has a terminal in its folder, or opens a new space for that folder.",
			dsh: "One space for all DSH sessions",
			dshHint: "All sessions share one space. It's named after the first session's folder until you rename it in Herdr App.",
			none: "Not in Herdr App",
			noneHint: "Sessions stay out of Herdr App, but still show in hc and other Herdr clients.",
			space: "Fixed space id",
			spaceHint: "A Herdr App space id. When set, it replaces the choice above.",
			applies: "Applies to terminals opened after you save; open ones stay where they are.",
			overridden: "Custom",
			reset: "Reset",
			invalid: "Not a valid value",
			unavailable: "This profile doesn't expose herdr-bridge settings.",
			readOnly: "This profile's configuration is read-only.",
			saveFailed: "Couldn't save. Try again.",
			save: "Save",
			saving: "Saving…",
		};
		const zh = {
			placement: "在 DSH 里发起的会话放在 Herdr App 的哪里",
			folder: "按文件夹归位",
			folderHint: "加入 Herdr App 里已经有终端在同一文件夹的那个 space；没有的话，为这个文件夹新开一个 space。",
			dsh: "统一放进一个 DSH space",
			dshHint: "所有会话共用一个 space。它先以第一个会话的文件夹命名，你在 Herdr App 里改名后就固定下来。",
			none: "不放进 Herdr App",
			noneHint: "会话不出现在 Herdr App 里，但 hc 和其他 Herdr 客户端照样能看到。",
			space: "固定 space id",
			spaceHint: "Herdr App 的 space id。填了就以它为准，忽略上面的选择。",
			applies: "保存后新开的终端按新设置放置；已经开着的终端位置不变。",
			overridden: "已自定义",
			reset: "重置",
			invalid: "不是有效的值",
			unavailable: "当前 profile 没有暴露 herdr-bridge 的设置。",
			readOnly: "当前 profile 的配置是只读的。",
			saveFailed: "保存失败，请重试。",
			save: "保存",
			saving: "保存中…",
		};

		const css = {
			field: { display: "flex", flexDirection: "column", gap: "6px", padding: "8px 0" },
			toolbar: { display: "flex", alignItems: "center", gap: "8px" },
			label: { fontSize: "13px", fontWeight: "600", color: "var(--dsw-alias-label-primary)" },
			select: {
				height: "34px", padding: "0 10px", maxWidth: "360px",
				border: "0.5px solid var(--dsw-alias-border-l4)", borderRadius: "var(--dsw-radius-md)",
				background: "var(--dsw-alias-bg-layer-3)", color: "var(--dsw-alias-label-primary)", font: "inherit", fontSize: "13px",
			},
			hint: { margin: 0, fontSize: "12px", lineHeight: "1.6", color: "var(--dsw-alias-label-secondary)" },
		};

		/** Staged edits of the two placement settings over the Host's form for this profile entry. */
		function placementForm(scope) {
			const form = new SettingsFormModel(scope, [{
				...settingsTextField("herdrPlacement"),
				parse: (text) => {
					const value = text.trim();
					if (value === "") return { kind: "clear" };
					return PLACEMENTS.includes(value) ? { kind: "set", value } : undefined;
				},
			}, settingsTextField("herdrSpace")]);
			const store = form.bind(() => ({
				...form.shell(),
				herdrPlacement: form.field("herdrPlacement"),
				herdrSpace: form.field("herdrSpace"),
			}));
			return { face: { hooks: { herdrBridgeForm: store }, ...form.actions() }, dispose: () => { form.dispose(); } };
		}

		/** The page: placement choice, optional fixed space id, and the shared save footer. */
		function SettingsPage(props) {
			const t = props.t;
			const state = props.useHerdrBridgeForm((snapshot) => snapshot);
			const id = useId();
			const disabled = !state.writable || state.saving;
			const placement = PLACEMENTS.includes(state.herdrPlacement.text) ? state.herdrPlacement.text : "folder";
			return h(SettingsForm, {
				labels: { unavailable: t("unavailable"), readOnly: t("readOnly"), saveFailed: t("saveFailed"), save: t("save"), saving: t("saving") },
				state,
				onSave: props.save,
				onDiscard: props.discard,
			},
				h("div", { style: css.field },
					h("div", { style: css.toolbar },
						h("label", { htmlFor: `${id}-placement`, style: css.label }, t("placement")),
						state.herdrPlacement.overridden ? h(Tag, { tone: "neutral" }, t("overridden")) : null,
						state.herdrPlacement.overridden
							? h(Button, { size: "sm", disabled, onClick: () => { props.resetField("herdrPlacement"); } }, t("reset"))
							: null,
					),
					h("select", {
						id: `${id}-placement`, value: placement, disabled, style: css.select,
						"aria-invalid": state.herdrPlacement.invalid || undefined,
						onChange: (event) => { props.edit("herdrPlacement", event.target.value); },
					}, PLACEMENTS.map((value) => h("option", { key: value, value }, t(value)))),
					h("p", { style: css.hint }, t(`${placement}Hint`)),
				),
				h(SettingsValueField, {
					id: `${id}-space`, label: t("space"), hint: t("spaceHint"), ...state.herdrSpace,
					overriddenLabel: t("overridden"), resetLabel: t("reset"), invalidLabel: t("invalid"), disabled,
					onEdit: (text) => { props.edit("herdrSpace", text); },
					onReset: () => { props.resetField("herdrSpace"); },
				}),
				h("p", { style: css.hint }, t("applies")),
			);
		}

		const inject = ["slots", "locale", "configForms"];

		/** Register the dictionaries and, while the Host serves the namespace, the settings on the bundle's page (between its detail and its components). */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { en, zh }), "herdr-bridge: dictionaries");
			const form = placementForm(ctx.configForms.get(SETTINGS));
			ctx.effect(() => () => { form.dispose(); }, "herdr-bridge: settings form");
			ctx.effect(() => ctx.configForms.whileServed([SETTINGS], () => ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
				name: "plugins.bundle.config",
				key: BUNDLE,
				locale: NS,
				inject: () => form.face,
			}, SettingsPage))), "herdr-bridge: settings page");
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
