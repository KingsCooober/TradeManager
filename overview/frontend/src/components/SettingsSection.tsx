import { ChevronRight } from 'lucide-react';
import type { KeyboardEventHandler, ReactNode } from 'react';

type Props = {
	title: string;
	description: string;
	icon: ReactNode;
	children: ReactNode;
	className?: string;
	onKeyDown?: KeyboardEventHandler<HTMLDetailsElement>;
};

export function SettingsSection({ title, description, icon, children, className = '', onKeyDown }: Props) {
	return (
		<details className={`settings-section settings-collapsible ${className}`} onKeyDown={onKeyDown} onInvalidCapture={(event) => { event.currentTarget.open = true; }}>
			<summary className="settings-section-title" aria-label={title}>
				{icon}
				<div><h3>{title}</h3><p>{description}</p></div>
				<ChevronRight size={18} className="settings-section-chevron" aria-hidden="true" />
			</summary>
			<div className="settings-section-content">{children}</div>
		</details>
	);
}
