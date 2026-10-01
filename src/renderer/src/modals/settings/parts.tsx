// Layout pieces shared by the settings tabs.
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cx } from '../../components/ui'

export function SettingGroup({ title, icon: Icon, right, children }: { title: ReactNode; icon?: LucideIcon; right?: ReactNode; children: ReactNode }) {
  return (
    <section className="st-group">
      <header className="st-group-head">
        {Icon && <Icon size={14} aria-hidden />}
        <h3>{title}</h3>
        {right && <div className="st-group-right">{right}</div>}
      </header>
      <div className="st-group-body">{children}</div>
    </section>
  )
}

/** Title + description on the left, control on the right (or below when `stacked`). */
export function SettingRow({
  title,
  desc,
  children,
  stacked,
  className,
  id,
}: {
  title: ReactNode
  desc?: ReactNode
  children: ReactNode
  stacked?: boolean
  className?: string
  id?: string
}) {
  return (
    <div className={cx('st-row', stacked && 'stacked', className)}>
      <div className="st-row-text">
        <div className="st-row-title" id={id}>
          {title}
        </div>
        {desc && <div className="st-row-desc">{desc}</div>}
      </div>
      <div className="st-row-control">{children}</div>
    </div>
  )
}

/** Read-only key/value line (versions, paths). */
export function InfoLine({ label, children, mono }: { label: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <div className="st-info">
      <span className="st-info-label">{label}</span>
      <span className={cx('st-info-value', mono && 'mono')}>{children}</span>
    </div>
  )
}
