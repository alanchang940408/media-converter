// Watch folders screen: explanation header, folder cards, empty state.
import { ArrowRight, FolderInput, FolderOutput, FolderPlus, FolderSync, Workflow } from 'lucide-react'
import { useStore, useT } from '../store'
import { Button } from '../components/ui'
import { WatchCard } from './watch/WatchCard'
import { addWatchFolder } from './watch/actions'

export function WatchView() {
  const t = useT()
  const folders = useStore((s) => s.watchFolders)
  const active = folders.filter((w) => w.enabled).length

  return (
    <div className="watch-view">
      <header className="wv-head">
        <span className="wv-head-icon" aria-hidden>
          <FolderSync size={20} />
        </span>
        <div className="wv-head-text">
          <h2>{t('watch.title')}</h2>
          <p>{t('watch.intro')}</p>
        </div>
        {folders.length > 0 && (
          <div className="wv-head-right">
            <span className="wv-summary">{t('watch.summary', { n: folders.length, active })}</span>
            <Button variant="primary" icon={FolderPlus} onClick={() => void addWatchFolder()}>
              {t('watch.add')}
            </Button>
          </div>
        )}
      </header>

      {folders.length === 0 ? (
        <div className="wv-empty">
          <div className="wv-empty-box">
            <div className="wv-flow" role="list" aria-label={t('watch.flowLabel')}>
              <div className="wv-flow-step" role="listitem">
                <span className="wv-flow-icon">
                  <FolderInput size={20} aria-hidden />
                </span>
                <span>{t('watch.flowDrop')}</span>
              </div>
              <ArrowRight size={16} className="wv-flow-arrow" aria-hidden />
              <div className="wv-flow-step" role="listitem">
                <span className="wv-flow-icon">
                  <Workflow size={20} aria-hidden />
                </span>
                <span>{t('watch.flowConvert')}</span>
              </div>
              <ArrowRight size={16} className="wv-flow-arrow" aria-hidden />
              <div className="wv-flow-step" role="listitem">
                <span className="wv-flow-icon">
                  <FolderOutput size={20} aria-hidden />
                </span>
                <span>{t('watch.flowOutput')}</span>
              </div>
            </div>
            <h3>{t('watch.emptyTitle')}</h3>
            <p>{t('watch.emptyBody')}</p>
            <Button variant="primary" size="lg" icon={FolderPlus} onClick={() => void addWatchFolder()}>
              {t('watch.add')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="wv-list">
          {folders.map((w) => (
            <WatchCard key={w.id} w={w} />
          ))}
          <button type="button" className="wv-add-card" onClick={() => void addWatchFolder()}>
            <FolderPlus size={16} aria-hidden />
            {t('watch.addAnother')}
          </button>
        </div>
      )}
    </div>
  )
}
