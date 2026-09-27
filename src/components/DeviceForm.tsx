import React from 'react';
import { RefreshCw, Wifi, EthernetPort } from 'lucide-react';
import { DeviceInterface, Group, Profile, POWER_OFF_ACTIONS, REBOOT_ACTIONS, HIBERNATE_ACTIONS } from '../types';
import { DEVICE_TYPES } from '../deviceTypes';
import { useI18n } from '../i18n';

export interface DeviceFormValues {
  name: string;
  hostname: string;
  ip: string;
  mac: string;
  type: string;
  profile_id: string;
  group_id: string;
  broadcast_address: string;
  base_power_w: string;
  poweroff_action: string;
  reboot_action: string;
  hibernate_action: string;
  disable_power: boolean;
  disable_ping: boolean;
  disable_terminal: boolean;
  disable_agent_update: boolean;
}

export const EMPTY_DEVICE_FORM: DeviceFormValues = {
  name: '',
  hostname: '',
  ip: '',
  mac: '',
  type: 'pc',
  profile_id: '',
  group_id: '',
  broadcast_address: '',
  base_power_w: '',
  poweroff_action: '',
  reboot_action: '',
  hibernate_action: '',
  disable_power: false,
  disable_ping: false,
  disable_terminal: false,
  disable_agent_update: false
};

export interface AgentSyncControls {
  onClick: () => void;
  loading: boolean;
  disabled: boolean;
  hint?: string | null;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{children}</span>
      <div className="h-px flex-1 bg-slate-200/80 dark:bg-white/10" />
    </div>
  );
}

function FieldLabel({ text, required }: { text: string; required?: boolean }) {
  return (
    <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
      {text}
      {required && <span className="text-rose-500 ms-0.5">*</span>}
    </label>
  );
}

function InterfacePicker({
  interfaces,
  selectedName,
  onSelect
}: {
  interfaces: DeviceInterface[];
  selectedName: string | null;
  onSelect: (iface: DeviceInterface) => void;
}) {
  const { t } = useI18n();
  if (interfaces.length === 0) return null;
  return (
    <div>
      <FieldLabel text={t('form.interfaces')} />
      <span className="block text-[10px] text-slate-500 dark:text-slate-600 -mt-0.5 mb-1">{t('form.interfacesNote')}</span>
      <div className="space-y-1.5">
        {interfaces.map((iface) => {
          const selected = iface.name === selectedName;
          return (
            <label
              key={iface.name}
              className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                selected
                  ? 'border-indigo-400 dark:border-indigo-500 bg-indigo-50/60 dark:bg-indigo-500/10'
                  : 'border-slate-200 dark:border-white/10 hover:border-slate-300 dark:hover:border-white/20'
              }`}
            >
              <input
                type="radio"
                name="wol-interface"
                className="accent-indigo-600"
                checked={selected}
                onChange={() => onSelect(iface)}
              />
              {iface.kind === 'wifi' ? (
                <Wifi size={14} className="text-slate-500 dark:text-slate-400 shrink-0" />
              ) : (
                <EthernetPort size={14} className="text-slate-500 dark:text-slate-400 shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-slate-700 dark:text-slate-300">{iface.name}</span>
                  <span
                    className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                      iface.kind === 'wifi'
                        ? 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300'
                        : 'bg-slate-100 dark:bg-white/10 text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {iface.kind === 'wifi' ? t('form.ifaceWifi') : iface.kind === 'eth' ? t('form.ifaceEthernet') : t('form.ifaceOther')}
                  </span>
                </div>
                <div className="text-[10px] font-mono text-slate-500 dark:text-slate-400 truncate">
                  {iface.mac || t('form.noMac')} · {iface.ips.length > 0 ? iface.ips.join(', ') : t('form.noIpv4')}
                </div>
              </div>
            </label>
          );
        })}
      </div>
    </div>
  );
}

const INPUT_CLS =
  'w-full bg-white/70 dark:bg-black/20 border border-slate-200 dark:border-white/10 rounded-lg px-3 py-2 text-slate-800 dark:text-slate-200 placeholder-slate-400 dark:placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500';
const SELECT_CLS = `${INPUT_CLS} [&>option]:bg-white dark:[&>option]:bg-slate-900`;

interface DeviceFormProps {
  values: DeviceFormValues;
  onChange: (values: DeviceFormValues) => void;
  profiles: Profile[];
  groups: Group[];
  interfaces: DeviceInterface[];
  selectedIfaceName: string | null;
  onIfaceSelect: (iface: DeviceInterface) => void;
  submitLabel: string;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
  agentSync?: AgentSyncControls;
}

const DISABLE_OPTIONS = [
  ['disable_power', 'form.disablePower'],
  ['disable_ping', 'form.disablePing'],
  ['disable_terminal', 'form.disableTerminal'],
  ['disable_agent_update', 'form.disableAgentUpdate'],
] as const;

export default function DeviceForm({
  values,
  onChange,
  profiles,
  groups,
  interfaces,
  selectedIfaceName,
  onIfaceSelect,
  submitLabel,
  onSubmit,
  onCancel,
  agentSync
}: DeviceFormProps) {
  const { t } = useI18n();
  const set = (patch: Partial<DeviceFormValues>) => onChange({ ...values, ...patch });

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="space-y-3">
        <SectionTitle>{t('form.sectionIdentity')}</SectionTitle>
        <div>
          <FieldLabel text={t('form.name')} required />
          <input
            required
            value={values.name}
            onChange={(e) => set({ name: e.target.value })}
            className={INPUT_CLS}
            placeholder={t('form.namePlaceholder')}
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <FieldLabel text={t('form.hostname')} />
            <input
              value={values.hostname}
              onChange={(e) => set({ hostname: e.target.value })}
              className={INPUT_CLS}
              placeholder={t('form.hostnamePlaceholder')}
            />
          </div>
          <div>
            <FieldLabel text={t('form.type')} />
            <select value={values.type} onChange={(e) => set({ type: e.target.value })} className={SELECT_CLS}>
              {DEVICE_TYPES.map((dt) => (
                <option key={dt.value} value={dt.value}>
                  {t(dt.labelKey)}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <SectionTitle>{t('form.sectionNetwork')}</SectionTitle>
        <InterfacePicker interfaces={interfaces} selectedName={selectedIfaceName} onSelect={onIfaceSelect} />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <FieldLabel text={t('form.ip')} required />
            <input
              required
              value={values.ip}
              onChange={(e) => set({ ip: e.target.value })}
              className={INPUT_CLS}
              placeholder={t('form.ipPlaceholder')}
            />
          </div>
          <div>
            <FieldLabel text={t('form.mac')} />
            <input
              value={values.mac}
              onChange={(e) => set({ mac: e.target.value })}
              className={INPUT_CLS}
              placeholder={t('form.macPlaceholder')}
            />
          </div>
        </div>
        <div>
          <FieldLabel text={t('form.broadcast')} />
          <input
            value={values.broadcast_address}
            onChange={(e) => set({ broadcast_address: e.target.value })}
            className={INPUT_CLS}
            placeholder="e.g. 192.168.1.255"
          />
          <p className="text-[10px] text-slate-500 dark:text-slate-600 mt-1">
            {t('form.broadcastNote')}
          </p>
        </div>
      </div>

      <div className="space-y-3">
        <SectionTitle>{t('form.sectionRemote')}</SectionTitle>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <FieldLabel text={t('form.profile')} />
            <select value={values.profile_id} onChange={(e) => set({ profile_id: e.target.value })} className={SELECT_CLS}>
              <option value="">{t('form.noProfile')}</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.username})
                </option>
              ))}
            </select>
          </div>
          <div>
            <FieldLabel text={t('form.group')} />
            <select value={values.group_id} onChange={(e) => set({ group_id: e.target.value })} className={SELECT_CLS}>
              <option value="">{t('form.noGroup')}</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <SectionTitle>{t('form.sectionPower')}</SectionTitle>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <FieldLabel text={t('form.poweroffCommand')} />
            <select value={values.poweroff_action} onChange={(e) => set({ poweroff_action: e.target.value })} className={SELECT_CLS}>
              <option value="">{t('settings.defaultGlobal')}</option>
              {POWER_OFF_ACTIONS.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
          <div>
            <FieldLabel text={t('form.rebootCommand')} />
            <select value={values.reboot_action} onChange={(e) => set({ reboot_action: e.target.value })} className={SELECT_CLS}>
              <option value="">{t('settings.defaultGlobal')}</option>
              {REBOOT_ACTIONS.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
          <div>
            <FieldLabel text={t('form.hibernateCommand')} />
            <select value={values.hibernate_action} onChange={(e) => set({ hibernate_action: e.target.value })} className={SELECT_CLS}>
              <option value="">{t('settings.defaultGlobal')}</option>
              {HIBERNATE_ACTIONS.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
        </div>
        <p className="text-[10px] text-slate-500 dark:text-slate-600">
          {t('form.commandNote')}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {DISABLE_OPTIONS.map(([key, labelKey]) => (
            <label
              key={key}
              className="flex items-center gap-2.5 rounded-lg border border-slate-200 dark:border-white/10 px-3 py-2 cursor-pointer hover:border-slate-300 dark:hover:border-white/20 transition-colors"
            >
              <input
                type="checkbox"
                className="accent-indigo-600"
                checked={values[key]}
                onChange={(e) => set({ [key]: e.target.checked })}
              />
              <span className="text-xs font-medium text-slate-700 dark:text-slate-300">{t(labelKey)}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <SectionTitle>{t('form.sectionEnergy')}</SectionTitle>
        <div>
          <FieldLabel text={t('form.basePower')} />
          <input
            type="number"
            min={0}
            max={10000}
            step={0.1}
            value={values.base_power_w}
            onChange={(e) => set({ base_power_w: e.target.value })}
            className={INPUT_CLS}
            placeholder="e.g. 120"
          />
          <p className="text-[10px] text-slate-500 dark:text-slate-600 mt-1">
            {t('form.basePowerNote')}
          </p>
        </div>
      </div>

      {agentSync && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 dark:border-white/10 bg-slate-50/80 dark:bg-white/5 px-3 py-2.5">
          <button
            type="button"
            onClick={agentSync.onClick}
            disabled={agentSync.disabled || agentSync.loading}
            className="inline-flex items-center gap-2 text-xs font-medium text-indigo-600 dark:text-indigo-300 hover:text-indigo-700 dark:hover:text-indigo-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <RefreshCw size={14} className={agentSync.loading ? 'animate-spin' : ''} />
            {t('form.syncFromAgent')}
          </button>
          {agentSync.hint && (
            <span className="text-[10px] text-slate-500 dark:text-slate-400 truncate">{agentSync.hint}</span>
          )}
        </div>
      )}

      <div className="sticky bottom-0 -mx-6 flex gap-3 border-t border-slate-200 dark:border-white/10 bg-white/95 px-6 pt-3 pb-[max(1.5rem,env(safe-area-inset-bottom))] backdrop-blur-md dark:bg-slate-900/95">
        <button type="submit" className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white font-medium px-4 py-2.5 rounded-lg transition-colors text-sm">
          {submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="flex-1 bg-slate-100 dark:bg-white/10 hover:bg-slate-200 dark:hover:bg-white/15 text-slate-700 dark:text-slate-300 font-medium px-4 py-2.5 rounded-lg transition-colors text-sm"
        >
          {t('common.cancel')}
        </button>
      </div>
    </form>
  );
}
