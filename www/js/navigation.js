import { drawHypnogram, drawTimelineReport } from './charts.js';
import { stopPlayback } from './player.js';
import { emptyState } from './report.js';
import { S } from './state.js';
import { renderTrends } from './trends.js';
import { $ } from './ui.js';

/* ============================================================
   NAVIGATION
   ============================================================ */
function switchView(v){
  document.querySelectorAll('.view').forEach(s=>s.classList.remove('active'));
  $('view-'+v).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(b=>b.classList.toggle('active',b.dataset.view===v));
  // stop snore playback when leaving the report
  if(v!=='report' && typeof stopPlayback==='function') stopPlayback();
  if(v==='report'&&!S.current){ $('reportBody').innerHTML=emptyState('No night analyzed yet','Record a night or load a sample on the Record tab.'); }
  // Canvases drawn while the view was hidden have zero size; redraw once visible.
  if(v==='report'&&S.current){ requestAnimationFrame(()=>{ drawTimelineReport(); drawHypnogram(); }); }
  if(v==='trends') renderTrends();
  window.scrollTo(0,0);
}
document.querySelectorAll('.nav-btn').forEach(b=>b.onclick=()=>switchView(b.dataset.view));

export { switchView };
