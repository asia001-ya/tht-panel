import type { ProviderProfile } from "../../api/types";

interface ProviderSelectProps {
  providers: ProviderProfile[];
  value?: string;
  inheritLabel?: string;
  disabled?: boolean;
  onChange: (providerId: string) => void;
}

export function ProviderSelect({
  providers,
  value = "",
  inheritLabel = "请选择供应商",
  disabled = false,
  onChange,
}: ProviderSelectProps): React.JSX.Element {
  return (
    <select
      className="dialog-input"
      aria-label="供应商"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{inheritLabel}</option>
      {providers.map((provider) => (
        <option key={provider.id} value={provider.id}>
          {provider.name}
        </option>
      ))}
    </select>
  );
}
