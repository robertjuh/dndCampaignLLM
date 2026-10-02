import { useEffect, useState } from 'react';
import { api } from './api';

export function ModelSelect({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [models, setModels] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ id: string; name: string }[]>('/api/chatgpt/models')
      .then(setModels)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load models.'));
  }, []);
  return (
    <label className="field">
      <span>ChatGPT model</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        <option value="">Automatic (first available model)</option>
        {value && !models.some((m) => m.id === value) && <option value={value}>{value}</option>}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      <small>
        For cheaper AI playtesting, choose GPT-6 Luna if available. Smaller models may give less detailed or
        reliable results. Automatic does not select by price.
      </small>
      {error && <small role="status">{error}</small>}
    </label>
  );
}
