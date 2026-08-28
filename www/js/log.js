import { switchView } from './navigation.js';
import { S } from './state.js';
import { renderTrends } from './trends.js';
import { $, toast } from './ui.js';

/* ============================================================
   LOG — lifestyle factors & remedies
   ============================================================ */
const FACTORS=['Alcohol','Late meal','Back sleeping','Stuffy nose','Stress','Travel','Antihistamine','Extra tired','Dry air','Caffeine pm'];
const REMEDIES=['Nasal strip','Mouth tape','Side pillow','Humidifier','Nasal spray','Mouthpiece','Elevated head','Throat exercises'];
function buildChips(){
  $('factorChips').innerHTML=FACTORS.map(f=>`<span class="chip" data-f="${f}">${f}</span>`).join('');
  $('remedyChips').innerHTML=REMEDIES.map(r=>`<span class="chip remedy" data-r="${r}">${r}</span>`).join('');
  document.querySelectorAll('.chip').forEach(c=>c.onclick=()=>c.classList.toggle('on'));
}
$('saveLog').addEventListener('click',()=>{
  if(!S.current){ toast('Analyze a night first, then log its factors.'); switchView('record'); return; }
  S.current.factors=[...document.querySelectorAll('#factorChips .chip.on')].map(c=>c.dataset.f);
  S.current.remedies=[...document.querySelectorAll('#remedyChips .chip.on')].map(c=>c.dataset.r);
  toast('Saved to last night ✓');
  renderTrends();
});

export { REMEDIES, buildChips };
