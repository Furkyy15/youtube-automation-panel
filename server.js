import express from "express";
import OpenAI from "openai";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
const __filename=fileURLToPath(import.meta.url),__dirname=path.dirname(__filename);
const ENV_FILE=path.join(__dirname,".env");
const PROFILE_FILE=path.join(__dirname,".api_profiles.json");
function readProfiles(){
  try{
    if(!fs.existsSync(PROFILE_FILE)) return {active_alias:null,profiles:{}};
    const j=JSON.parse(fs.readFileSync(PROFILE_FILE,"utf8"));
    if(!j || typeof j!=="object") return {active_alias:null,profiles:{}};
    if(!j.profiles || typeof j.profiles!=="object") j.profiles={};
    return j;
  }catch{return {active_alias:null,profiles:{}}}
}
function writeProfiles(j){
  fs.writeFileSync(PROFILE_FILE,JSON.stringify(j,null,2)+"\n","utf8");
}
function cleanAlias(alias=""){
  return String(alias).trim().toLocaleLowerCase("tr-TR").normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9_-]/g,"-").replace(/-+/g,"-").replace(/^-|-$/g,"").slice(0,40);
}
function activateProfile(alias){
  const store=readProfiles();
  const key=cleanAlias(alias);
  const p=store.profiles[key];
  if(!p) return false;
  if(p.openai) process.env.OPENAI_API_KEY=p.openai;
  if(p.pexels) process.env.PEXELS_API_KEY=p.pexels;
  if(p.pixabay) process.env.PIXABAY_API_KEY=p.pixabay;
  store.active_alias=key;
  writeProfiles(store);
  refreshOpenAIClient();
  return true;
}
function loadEnvFile(){
  try{
    if(!fs.existsSync(ENV_FILE)) return;
    const text=fs.readFileSync(ENV_FILE,"utf8");
    for(const rawLine of text.split(/\r?\n/)){
      const line=rawLine.trim();
      if(!line || line.startsWith("#")) continue;
      const i=line.indexOf("=");
      if(i<1) continue;
      const key=line.slice(0,i).trim();
      let value=line.slice(i+1).trim();
      if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'"))) value=value.slice(1,-1);
      if(!process.env[key] && value) process.env[key]=value;
    }
  }catch(e){console.error("ENV yükleme hatası:",e.message)}
}
function envFileObject(){
  const base={OPENAI_API_KEY:"",PEXELS_API_KEY:"",PIXABAY_API_KEY:"",OPENAI_MODEL:"gpt-5.6",PORT:"3000"};
  try{
    if(fs.existsSync(ENV_FILE)){
      const text=fs.readFileSync(ENV_FILE,"utf8");
      for(const rawLine of text.split(/\r?\n/)){
        const line=rawLine.trim(); if(!line||line.startsWith("#")) continue;
        const i=line.indexOf("="); if(i<1) continue;
        base[line.slice(0,i).trim()]=line.slice(i+1).trim();
      }
    }
  }catch{}
  return base;
}
function saveEnvValues(values={}){
  const current=envFileObject();
  const allowed=["OPENAI_API_KEY","PEXELS_API_KEY","PIXABAY_API_KEY","OPENAI_MODEL","PORT"];
  for(const key of allowed){
    if(values[key]!==undefined && values[key]!==null){
      const v=String(values[key]).trim().replace(/[\r\n]/g,"");
      if(v) current[key]=v;
    }
  }
  const lines=[
    `OPENAI_API_KEY=${current.OPENAI_API_KEY||""}`,
    `PEXELS_API_KEY=${current.PEXELS_API_KEY||""}`,
    `PIXABAY_API_KEY=${current.PIXABAY_API_KEY||""}`,
    `OPENAI_MODEL=${current.OPENAI_MODEL||"gpt-5.6"}`,
    `PORT=${current.PORT||"3000"}`
  ];
  fs.writeFileSync(ENV_FILE,lines.join("\n")+"\n","utf8");
  for(const key of allowed){ if(current[key]) process.env[key]=current[key]; }
  return current;
}
loadEnvFile();
const app=express(); app.use(express.json({limit:"2mb"})); app.use(express.static(path.join(__dirname,"public")));
const locData=JSON.parse(fs.readFileSync(path.join(__dirname,"public","locations.json"),"utf8"));
const locations=locData.locations, locationById=new Map(locations.map(x=>[x.id,x]));
const commonAnimals=JSON.parse(fs.readFileSync(path.join(__dirname,"public","animals_common.json"),"utf8")).animals;
const videoFormats=JSON.parse(fs.readFileSync(path.join(__dirname,"public","video_formats.json"),"utf8")).formats;
const visualModes=JSON.parse(fs.readFileSync(path.join(__dirname,"public","visual_modes.json"),"utf8"));
const visualStrategy=JSON.parse(fs.readFileSync(path.join(__dirname,"public","visual_strategy.json"),"utf8"));
const comparisonModes=JSON.parse(fs.readFileSync(path.join(__dirname,"public","comparison_modes.json"),"utf8"));
const vsTemplates=JSON.parse(fs.readFileSync(path.join(__dirname,"public","vs_templates.json"),"utf8")).templates;
const clickPackage=JSON.parse(fs.readFileSync(path.join(__dirname,"public","click_package.json"),"utf8"));
const realMediaConfig=JSON.parse(fs.readFileSync(path.join(__dirname,"public","real_media_config.json"),"utf8"));
let client=null;
function refreshOpenAIClient(){
  const key=String(process.env.OPENAI_API_KEY||"").trim();
  client=key?new OpenAI({apiKey:key}):null;
}
refreshOpenAIClient();
const animalCache=new Map();
function getOpenAI(){
  if(!client){
    const e=new Error("OPENAI_API_KEY eksik. Uygulamadaki Kurulum bölümünden anahtarı kaydet.");
    e.code="OPENAI_KEY_MISSING";
    throw e;
  }
  return client;
}
const HABITAT_TAGS=[...new Set(locations.flatMap(x=>x.habitat_tags))].sort();
function normalize(s=""){return s.toLocaleLowerCase("tr-TR").normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^\p{L}\p{N}\s-]/gu," ").replace(/\s+/g," ").trim()}
function localCandidates(q){const n=normalize(q);return commonAnimals.map(a=>{let score=0;for(const f of [a.display_name,a.scientific_name,...a.aliases]){const z=normalize(f);if(z===n)score=Math.max(score,100);else if(z.startsWith(n))score=Math.max(score,80);else if(z.includes(n))score=Math.max(score,60)}return{...a,score}}).filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,8)}
function exactLocal(q){const n=normalize(q);return commonAnimals.find(a=>[a.display_name,a.scientific_name,...a.aliases].some(v=>normalize(v)===n))}
async function gbifSuggest(q){try{const r=await fetch("https://api.gbif.org/v1/species/suggest?q="+encodeURIComponent(q)+"&limit=8");if(!r.ok)return[];const j=await r.json();return j.filter(x=>normalize(x.kingdom)==="animalia").slice(0,8).map(x=>({display_name:x.canonicalName||x.scientificName,scientific_name:x.scientificName||x.canonicalName,rank:x.rank||"",source:"GBIF"}))}catch{return[]}}
async function gbifMatch(scientificName){try{const r=await fetch("https://api.gbif.org/v2/species/match?scientificName="+encodeURIComponent(scientificName)+"&kingdom=Animalia");if(!r.ok)return null;const j=await r.json(),u=j.usage||j;if(!u?.name)return null;const cls=j.classification||[];if(!cls.some(c=>normalize(c.name)==="animalia")&&u.code!=="ZOOLOGICAL")return null;return{key:u.key||null,scientific_name:u.canonicalName||u.name,full_name:u.name,rank:u.rank||"",status:u.status||"",source:"GBIF"}}catch{return null}}
async function aiResolveName(query){const r=await getOpenAI().responses.create({model:process.env.OPENAI_VALIDATOR_MODEL||process.env.OPENAI_MODEL||"gpt-5.6",reasoning:{effort:"medium"},input:`Kullanıcının yazdığı adı zoolojik taksona çöz. Türkçe/İngilizce/bilimsel ad veya küçük yazım hatası olabilir. Geniş grup adıysa rastgele tür seçme. Hayvan değilse reddet. SADECE JSON: {"valid":true,"display_name_tr":"...","scientific_name":"...","rank":"SPECIES|GENUS|FAMILY|ORDER|CLASS|OTHER","broad_group":false,"confidence":0.0,"alternatives":[]} veya {"valid":false,"reason":"..."}. Girdi: ${query}`});try{return JSON.parse(r.output_text.trim().replace(/^```json\s*/i,"").replace(/```$/i,""))}catch{return{valid:false,reason:"Hayvan adı güvenilir biçimde çözülemedi."}}}
async function habitatProfile(animal){const r=await getOpenAI().responses.create({model:process.env.OPENAI_VALIDATOR_MODEL||process.env.OPENAI_MODEL||"gpt-5.6",reasoning:{effort:"medium"},input:`Doğrulanmış zoolojik takson için doğal habitat profili oluştur. Esaret, taşıma veya kazara bulunmayı sayma. Geniş taksonlarda aşırı dar davranma ama mantıksız biyomları yasakla. Yalnızca şu etiketleri kullan: ${HABITAT_TAGS.join(", ")}. Hayvan: ${animal.display_name}; Bilimsel: ${animal.scientific_name}; Rank: ${animal.rank}. SADECE JSON: {"primary_tags":[],"secondary_tags":[],"forbidden_tags":[],"water_relation":"marine|freshwater|semi_aquatic|terrestrial|amphibious|mixed","climate_notes":"...","reason":"...","confidence":0.0}`});let j;try{j=JSON.parse(r.output_text.trim().replace(/^```json\s*/i,"").replace(/```$/i,""))}catch{throw new Error("Habitat profili çözülemedi.")}const allowed=new Set(HABITAT_TAGS),clean=a=>Array.isArray(a)?[...new Set(a.filter(x=>allowed.has(x)))]:[];return{primary_tags:clean(j.primary_tags),secondary_tags:clean(j.secondary_tags),forbidden_tags:clean(j.forbidden_tags),water_relation:j.water_relation||"mixed",climate_notes:String(j.climate_notes||""),reason:String(j.reason||""),confidence:Number(j.confidence||0)}}
function scoreLocations(pf){const p=new Set(pf.primary_tags),s=new Set(pf.secondary_tags),f=new Set(pf.forbidden_tags);return locations.map(loc=>{const t=new Set(loc.habitat_tags);if([...t].some(x=>f.has(x)))return null;const pm=[...t].filter(x=>p.has(x)),sm=[...t].filter(x=>s.has(x));let score=pm.length*12+sm.length*4;if(pf.water_relation==="marine"&&!t.has("marine")&&!t.has("coastal_water")&&!t.has("polar_marine"))return null;if(pf.water_relation==="freshwater"&&!t.has("freshwater")&&!t.has("wetland")&&!t.has("riparian"))return null;if(pf.water_relation==="terrestrial"&&(t.has("deep_sea")||(t.has("open_water")&&t.has("pelagic"))))return null;if(score<=0)return null;return{...loc,match_score:score,match_tags:[...pm,...sm]}}).filter(Boolean).sort((a,b)=>b.match_score-a.match_score||a.name.localeCompare(b.name,"tr"))}
function compareOverlap(primaryCache, opponentCache, selectedLocationId){
  const selectedForOpponent = opponentCache?.locationIds?.has(selectedLocationId) || false;
  let overlapCount = 0;
  if(primaryCache?.locationIds && opponentCache?.locationIds){
    for(const id of primaryCache.locationIds){ if(opponentCache.locationIds.has(id)) overlapCount++; }
  }
  return {selectedForOpponent, overlapCount};
}


const MEDIA_API_CACHE_DIR=path.join(__dirname,'.media_api_cache');
fs.mkdirSync(MEDIA_API_CACHE_DIR,{recursive:true});
const inMemoryApiCache=new Map();
function cacheFileFor(key){return path.join(MEDIA_API_CACHE_DIR,crypto.createHash('sha256').update(key).digest('hex')+'.json')}
function readApiCache(key,maxAgeMs){
  const mem=inMemoryApiCache.get(key);
  if(mem && Date.now()-mem.savedAt<maxAgeMs) return mem.value;
  try{
    const f=cacheFileFor(key); if(!fs.existsSync(f)) return null;
    const j=JSON.parse(fs.readFileSync(f,'utf8'));
    if(Date.now()-Number(j.savedAt||0)>=maxAgeMs) return null;
    inMemoryApiCache.set(key,j); return j.value;
  }catch{return null}
}
function writeApiCache(key,value){
  const payload={savedAt:Date.now(),value};
  inMemoryApiCache.set(key,payload);
  try{fs.writeFileSync(cacheFileFor(key),JSON.stringify(payload),'utf8')}catch{}
}
async function cachedJsonFetch(url,options={},maxAgeMs=0){
  const auth=options?.headers?.Authorization?'auth':'public';
  const key=`${auth}:${url}`;
  if(maxAgeMs>0){const cached=readApiCache(key,maxAgeMs); if(cached) return {ok:true,status:200,json:async()=>cached,headers:new Headers(),cached:true}}
  const r=await fetch(url,options);
  if(!r.ok) return r;
  const j=await r.json();
  if(maxAgeMs>0) writeApiCache(key,j);
  return {ok:true,status:r.status,json:async()=>j,headers:r.headers,cached:false};
}
function clampInt(v,min,max,def){const n=Number(v); return Number.isFinite(n)?Math.min(max,Math.max(min,Math.floor(n))):def}
function mediaAttribution(provider,item={}){
  if(provider==='pexels') return item.creator?`Photo/video by ${item.creator} on Pexels`:'Media provided by Pexels';
  if(provider==='pixabay') return item.creator?`Media by ${item.creator} on Pixabay`:'Media provided by Pixabay';
  if(provider==='wikimedia') return `Media from Wikimedia Commons — ${item.license||'license metadata required'}`;
  if(provider==='openverse') return item.creator?`Openly licensed media by ${item.creator} via Openverse`:'Openly licensed media via Openverse';
  return '';
}

function providerStatus(){
  return {
    wikimedia:{enabled:true,supports:['image','video'],requires_key:false,attribution:'Wikimedia Commons license and author metadata must be retained'},
    openverse:{enabled:true,supports:['image'],requires_key:false,attribution:'Openverse aggregates openly licensed media; verify the work license before publishing'},
    pexels:{enabled:!!process.env.PEXELS_API_KEY,supports:['image','video'],requires_key:true,env:'PEXELS_API_KEY',photo_endpoint:'https://api.pexels.com/v1/search',video_endpoint:'https://api.pexels.com/v1/videos/search',default_limits:'200/hour, 20000/month',attribution:'Prominent Pexels link; photographer credit when possible'},
    pixabay:{enabled:!!process.env.PIXABAY_API_KEY,supports:['image','video'],requires_key:true,env:'PIXABAY_API_KEY',photo_endpoint:'https://pixabay.com/api/',video_endpoint:'https://pixabay.com/api/videos/',default_limits:'100 requests/60 seconds',cache_rule:'API responses cached 24 hours',attribution:'Show users media source; permanent image hotlinking is not allowed'}
  };
}
function chooseVideoFile(files=[]){
  const arr=[...files].filter(x=>x?.link).sort((a,b)=>((b.width||0)*(b.height||0))-((a.width||0)*(a.height||0)));
  return arr.find(x=>(x.height||0)<=1080 && String(x.file_type||'').includes('mp4')) || arr.find(x=>String(x.file_type||'').includes('mp4')) || arr[0] || null;
}
function scoreMediaItem(item, preferredKind='both'){
  let score=0;
  if(item.provider==='pexels') score+=20;
  if(item.provider==='pixabay') score+=14;
  if(item.provider==='wikimedia') score+=12;
  if(item.provider==='openverse') score+=11;
  if(preferredKind!=='both' && item.kind===preferredKind) score+=8;
  if(item.kind==='video') score+=6;
  if(item.width&&item.height){
    const ratio=item.width/item.height;
    if(ratio>0.5 && ratio<2.2) score+=4;
    if(item.width>=1200||item.height>=1200) score+=5;
  }
  if(item.duration) score+=Math.min(8, Math.round(item.duration/8));
  if(item.views) score+=Math.min(10, Math.floor(item.views/1000));
  if(item.downloads) score+=Math.min(10, Math.floor(item.downloads/100));
  return score;
}
function dedupeMediaItems(items=[]){
  const seen=new Set(), out=[];
  for(const item of items){
    const key=(item.page_url||item.asset_url||item.preview_url||item.id||'').toLowerCase();
    if(!key || seen.has(key)) continue;
    seen.add(key); out.push(item);
  }
  return out;
}
function buildRealMediaLayers({animal, profile, location, videoType, compareType, opponentAnimal, requestedKind}){
  const water=profile?.water_relation || 'mixed';
  const actionPool=realMediaConfig.water_relation_actions[water] || realMediaConfig.water_relation_actions.mixed;
  const baseCount = compareType ? realMediaConfig.layer_counts.comparison : (videoType==='Uzun Video' ? realMediaConfig.layer_counts.long : realMediaConfig.layer_counts.short);
  const layers=[];
  const push=(id,label,kind,action,queryHints=[])=>layers.push({id,label,kind,action,queryHints,animal_name:animal.display_name,scientific_name:animal.scientific_name,location_name:location.name,category_name:location.category_name});

  if(compareType==='animal_vs_animal'){
    push('side_a_portrait', `${animal.display_name} yakın plan`, requestedKind==='video'?'image':requestedKind, 'portrait close-up', ['portrait','wildlife']);
    push('side_a_action', `${animal.display_name} aksiyon`, requestedKind, actionPool[1]||'movement action', ['action']);
    push('side_b_portrait', `${opponentAnimal.display_name} yakın plan`, requestedKind==='video'?'image':requestedKind, 'portrait close-up', ['portrait','wildlife']);
    push('side_b_action', `${opponentAnimal.display_name} aksiyon`, requestedKind, actionPool[2]||'movement action', ['action']);
    push('comparison_scale', 'Ölçek karşılaştırması', 'image', 'size comparison', ['size comparison','split concept']);
    push('comparison_power', 'Güç / gerilim hissi', requestedKind, 'dramatic stance', ['dramatic']);
    push('comparison_habitat', 'Ortak / nötr habitat hissi', 'image', 'habitat wide shot', ['habitat']);
    push('hook_layer', 'Hook için durduran kare', requestedKind, 'hero moment', ['hero shot']);
  }else if(compareType==='human_vs_animal'){
    push('animal_portrait', `${animal.display_name} yakın plan`, requestedKind==='video'?'image':requestedKind, 'portrait close-up', ['portrait']);
    push('animal_action', `${animal.display_name} aksiyon`, requestedKind, actionPool[1]||'movement action', ['action']);
    push('human_reference', 'İnsan referans karesi', requestedKind==='video'?'image':requestedKind, 'human reference', ['adult person outdoors']);
    push('comparison_scale', 'İnsan vs hayvan ölçek kıyası', 'image', 'size comparison', ['size comparison']);
    push('comparison_environment', 'Aynı ortam hissi', 'image', 'environment comparison', ['environment']);
    push('hook_layer', 'Hook için durduran kare', requestedKind, 'hero moment', ['hero shot']);
  }else{
    push('hook_portrait', 'Hook yakın plan', requestedKind==='video'?'image':requestedKind, actionPool[0]||'portrait close-up', ['close up']);
    push('action_primary', 'Ana aksiyon sahnesi', requestedKind, actionPool[2]||'movement action', ['action']);
    push('behavior_secondary', 'Davranış sahnesi', requestedKind, actionPool[3]||'feeding behavior', ['behavior']);
    push('wide_habitat', 'Geniş habitat karesi', 'image', actionPool[5]||'habitat wide shot', ['habitat']);
    push('detail_texture', 'Doku / detay karesi', 'image', actionPool[4]||'detail texture', ['detail']);
    push('hook_layer', 'Hook için güçlü kare', requestedKind, 'hero moment', ['hero']);
    if(videoType==='Uzun Video'){
      push('secondary_movement', 'İkinci hareket sahnesi', requestedKind, actionPool[1]||'movement action', ['movement']);
      push('environment_extra', 'Ek çevre sahnesi', 'image', 'environmental context', ['environment']);
    }
  }
  return layers.slice(0, baseCount);
}
function buildLayerQueries(layer, animal, location){
  const species = animal.scientific_name;
  const common = animal.display_name;
  const loc = location.name;
  const queryBase = [species, common, layer.action, ...layer.queryHints].filter(Boolean);
  const queries = [];
  queries.push(queryBase.join(' '));
  queries.push([species, layer.action].filter(Boolean).join(' '));
  if(layer.id.includes('human_reference')) queries.push('adult person outdoors wildlife reference');
  if(layer.id.includes('comparison_scale')) queries.push([species, 'wildlife size comparison reference'].join(' '));
  queries.push([common, loc, layer.action].filter(Boolean).join(' '));
  return [...new Set(queries.map(x=>x.trim()).filter(Boolean))].slice(0,4);
}
async function searchPexelsPhotos(query, perPage=8, page=1){
  if(!process.env.PEXELS_API_KEY) return {items:[],page,total_results:0,next_page:null};
  perPage=clampInt(perPage,1,80,8); page=clampInt(page,1,100000,1);
  const url=`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=${perPage}&page=${page}`;
  const r=await cachedJsonFetch(url,{headers:{Authorization:process.env.PEXELS_API_KEY}},15*60*1000);
  if(!r.ok) return {items:[],page,total_results:0,next_page:null,error:`Pexels HTTP ${r.status}`};
  const j=await r.json();
  const items=(j.photos||[]).map(x=>{
    const item={id:`pexels-photo-${x.id}`,provider:'pexels',kind:'image',title:x.alt||query,creator:x.photographer||'',creator_url:x.photographer_url||'',license:'Pexels License',page_url:x.url,asset_url:x.src?.original||x.src?.large2x||x.src?.large||x.src?.medium,preview_url:x.src?.medium||x.src?.small||x.src?.tiny,width:x.width,height:x.height};
    item.attribution=mediaAttribution('pexels',item); return item;
  });
  return {items,page:j.page||page,per_page:j.per_page||perPage,total_results:j.total_results||0,next_page:j.next_page||null,prev_page:j.prev_page||null};
}
async function searchPexelsVideos(query, perPage=6, page=1){
  if(!process.env.PEXELS_API_KEY) return {items:[],page,total_results:0,next_page:null};
  perPage=clampInt(perPage,1,80,6); page=clampInt(page,1,100000,1);
  const url=`https://api.pexels.com/v1/videos/search?query=${encodeURIComponent(query)}&per_page=${perPage}&page=${page}`;
  const r=await cachedJsonFetch(url,{headers:{Authorization:process.env.PEXELS_API_KEY}},15*60*1000);
  if(!r.ok) return {items:[],page,total_results:0,next_page:null,error:`Pexels HTTP ${r.status}`};
  const j=await r.json();
  const items=(j.videos||[]).map(x=>{const file=chooseVideoFile(x.video_files||[]); const item={id:`pexels-video-${x.id}`,provider:'pexels',kind:'video',title:query,creator:x.user?.name||'',creator_url:x.user?.url||'',license:'Pexels License',page_url:x.url||'',asset_url:file?.link||'',preview_url:x.image||'',width:file?.width||x.width||0,height:file?.height||x.height||0,duration:x.duration||0}; item.attribution=mediaAttribution('pexels',item); return item}).filter(x=>x.asset_url||x.preview_url);
  return {items,page:j.page||page,per_page:j.per_page||perPage,total_results:j.total_results||0,next_page:j.next_page||null,prev_page:j.prev_page||null};
}
async function searchPixabayImages(query, perPage=8, page=1){
  if(!process.env.PIXABAY_API_KEY) return {items:[],page,total_results:0,next_page:null};
  perPage=clampInt(perPage,3,200,8); page=clampInt(page,1,100000,1);
  const url=`https://pixabay.com/api/?key=${encodeURIComponent(process.env.PIXABAY_API_KEY)}&q=${encodeURIComponent(query)}&image_type=photo&category=animals&per_page=${perPage}&page=${page}&safesearch=true&order=popular`;
  const r=await cachedJsonFetch(url,{},24*60*60*1000);
  if(!r.ok) return {items:[],page,total_results:0,next_page:null,error:`Pixabay HTTP ${r.status}`};
  const j=await r.json();
  const items=(j.hits||[]).map(x=>{const item={id:`pixabay-image-${x.id}`,provider:'pixabay',kind:'image',title:x.tags||query,creator:x.user||'',creator_url:x.user_id&&x.user?`https://pixabay.com/users/${encodeURIComponent(x.user)}-${x.user_id}/`:'',license:'Pixabay Content License',page_url:x.pageURL,asset_url:x.largeImageURL||x.webformatURL,preview_url:x.webformatURL||x.previewURL,width:x.imageWidth,height:x.imageHeight,views:x.views||0,downloads:x.downloads||0,likes:x.likes||0}; item.attribution=mediaAttribution('pixabay',item); return item});
  const total=Math.min(Number(j.totalHits||0),500);
  return {items,page,per_page:perPage,total_results:total,next_page:page*perPage<total?page+1:null,prev_page:page>1?page-1:null,cached:!!r.cached};
}
async function searchPixabayVideos(query, perPage=6, page=1){
  if(!process.env.PIXABAY_API_KEY) return {items:[],page,total_results:0,next_page:null};
  perPage=clampInt(perPage,3,200,6); page=clampInt(page,1,100000,1);
  const url=`https://pixabay.com/api/videos/?key=${encodeURIComponent(process.env.PIXABAY_API_KEY)}&q=${encodeURIComponent(query)}&category=animals&per_page=${perPage}&page=${page}&safesearch=true&order=popular`;
  const r=await cachedJsonFetch(url,{},24*60*60*1000);
  if(!r.ok) return {items:[],page,total_results:0,next_page:null,error:`Pixabay HTTP ${r.status}`};
  const j=await r.json();
  const items=(j.hits||[]).map(x=>{const file=x.videos?.medium || x.videos?.small || x.videos?.large || x.videos?.tiny; const item={id:`pixabay-video-${x.id}`,provider:'pixabay',kind:'video',title:x.tags||query,creator:x.user||'',creator_url:x.user_id&&x.user?`https://pixabay.com/users/${encodeURIComponent(x.user)}-${x.user_id}/`:'',license:'Pixabay Content License',page_url:x.pageURL,asset_url:file?.url||'',preview_url:file?.thumbnail||x.videos?.tiny?.thumbnail||'',width:file?.width||0,height:file?.height||0,duration:x.duration||0,views:x.views||0,downloads:x.downloads||0,likes:x.likes||0}; item.attribution=mediaAttribution('pixabay',item); return item}).filter(x=>x.asset_url||x.preview_url);
  const total=Math.min(Number(j.totalHits||0),500);
  return {items,page,per_page:perPage,total_results:total,next_page:page*perPage<total?page+1:null,prev_page:page>1?page-1:null,cached:!!r.cached};
}
async function searchWikimediaMedia(query, limit=12, kind='both'){
  limit=clampInt(limit,1,30,12);
  const url=`https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(query)}&gsrlimit=${limit}&prop=imageinfo|info&iiprop=url|size|mime|mediatype|extmetadata&iiurlwidth=640&inprop=url`;
  const r=await cachedJsonFetch(url,{},30*60*1000);
  if(!r.ok) return {items:[],page:1,total_results:0,next_page:null,error:`Wikimedia HTTP ${r.status}`};
  const j=await r.json();
  const pages=Object.values(j.query?.pages||{});
  const items=pages.map(p=>{
    const ii=p.imageinfo?.[0]||{};
    const mime=String(ii.mime||'').toLowerCase();
    const mediatype=String(ii.mediatype||'').toUpperCase();
    const itemKind = mime.startsWith('video/') || ['VIDEO','MULTIMEDIA'].includes(mediatype) ? 'video' : 'image';
    const ext=ii.extmetadata||{};
    const item={
      id:`wikimedia-${p.pageid}`,provider:'wikimedia',kind:itemKind,
      title:p.title?.replace(/^File:/,'')||query,
      creator:String(ext.Artist?.value||'Wikimedia Commons').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(),
      license:ext.LicenseShortName?.value || ext.UsageTerms?.value || 'Wikimedia Commons license metadata',
      license_url:ext.LicenseUrl?.value || '',
      page_url:p.fullurl||'',asset_url:ii.url||'',preview_url:ii.thumburl||ii.url||'',
      width:ii.width||0,height:ii.height||0,mime,mediatype,
      description:String(ext.ImageDescription?.value||'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim()
    };
    item.attribution=mediaAttribution('wikimedia',item); return item;
  }).filter(x=>(kind==='both'||x.kind===kind)&&(x.asset_url||x.preview_url));
  return {items,page:1,per_page:limit,total_results:items.length,next_page:null};
}
async function searchOpenverseImages(query, perPage=12, page=1){
  perPage=clampInt(perPage,1,50,12); page=clampInt(page,1,1000,1);
  const url=`https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&page_size=${perPage}&page=${page}&mature=false`;
  const r=await cachedJsonFetch(url,{headers:{'User-Agent':'YouTube-Automation-Panel/0.18.1'}},30*60*1000);
  if(!r.ok) return {items:[],page,total_results:0,next_page:null,error:`Openverse HTTP ${r.status}`};
  const j=await r.json();
  const items=(j.results||[]).map(x=>{const item={
    id:`openverse-${x.id}`,provider:'openverse',kind:'image',title:x.title||query,
    creator:x.creator||'',creator_url:x.creator_url||'',license:[x.license,x.license_version].filter(Boolean).join(' '),license_url:x.license_url||'',
    page_url:x.foreign_landing_url||x.detail_url||'',asset_url:x.url||'',preview_url:x.thumbnail||x.url||'',width:x.width||0,height:x.height||0,
    source:x.source||'',provider_name:x.provider||''
  }; item.attribution=mediaAttribution('openverse',item); return item}).filter(x=>x.asset_url||x.preview_url);
  return {items,page,per_page:perPage,total_results:Number(j.result_count||j.count||0),next_page:j.next?page+1:null,prev_page:j.previous&&page>1?page-1:null};
}
async function searchLayerAssets(layer, animal, location, requestedKind='both'){
  const queries=buildLayerQueries(layer, animal, location).slice(0,2);
  const batches=[];
  for(const query of queries){
    if(requestedKind!=='video') batches.push(searchWikimediaMedia(query,8,'image'),searchOpenverseImages(query,8,1),searchPexelsPhotos(query,6,1),searchPixabayImages(query,6,1));
    if(requestedKind!=='image') batches.push(searchWikimediaMedia(query,8,'video'),searchPexelsVideos(query,5,1),searchPixabayVideos(query,5,1));
  }
  const settled=await Promise.allSettled(batches);
  const all=[];
  for(const s of settled){
    if(s.status!=='fulfilled') continue;
    const v=s.value;
    if(Array.isArray(v)) all.push(...v); else if(Array.isArray(v?.items)) all.push(...v.items);
  }
  return dedupeMediaItems(all).map(x=>({...x,score:scoreMediaItem(x,requestedKind),query_used:queries[0]})).sort((a,b)=>b.score-a.score).slice(0,12);
}

app.get("/api/animal/suggest",async(req,res)=>{const q=String(req.query.q||"").trim();if(q.length<2)return res.json([]);const local=localCandidates(q).map(x=>({...x,source:"Yerel hızlı sözlük"}));const remote=local.length<5?await gbifSuggest(q):[];const seen=new Set(),out=[];for(const x of [...local,...remote]){const k=normalize(x.scientific_name||x.display_name);if(!k||seen.has(k))continue;seen.add(k);out.push(x);if(out.length>=10)break}res.json(out)});
app.post("/api/animal/resolve",async(req,res)=>{try{const query=String(req.body?.query||"").trim();if(!query)return res.status(400).json({error:"Hayvan adı boş olamaz."});const local=exactLocal(query);let c=local?{valid:true,display_name_tr:local.display_name,scientific_name:local.scientific_name,rank:local.rank||"",broad_group:!!local.broad_group}:await aiResolveName(query);if(!c.valid)return res.status(422).json({error:c.reason||"Hayvan adı çözülemedi.",alternatives:c.alternatives||[]});const verified=await gbifMatch(c.scientific_name);if(!verified)return res.status(422).json({error:"Hayvan adı bulundu ancak zoolojik takson doğrulanamadı."});const animal={query,display_name:c.display_name_tr||local?.display_name||verified.scientific_name,scientific_name:verified.scientific_name,full_name:verified.full_name,rank:verified.rank||c.rank||"",broad_group:!!c.broad_group,taxonomy_source:"GBIF",taxon_key:verified.key};const profile=await habitatProfile(animal),compatible=scoreLocations(profile);if(!compatible.length)return res.status(422).json({error:"Bu hayvan için 500 mekan içinde güvenilir doğal habitat eşleşmesi bulunamadı."});const token=crypto.randomUUID();animalCache.set(token,{animal,profile,locationIds:new Set(compatible.map(x=>x.id)),createdAt:Date.now()});const cats=[...new Map(compatible.map(x=>[x.category_id,{id:x.category_id,name:x.category_name}])).values()];const tierMeta=defaultTierMeta(animal.scientific_name);res.json({token,animal,profile,tier_meta:tierMeta,categories:cats,locations:compatible})}catch(e){console.error(e);res.status(500).json({error:e?.message||"Hayvan çözümleme hatası."})}});

app.post("/api/opponent/resolve",async(req,res)=>{
  try{
    const query=String(req.body?.query||"").trim();
    if(!query) return res.status(400).json({error:"Karşı taraf hayvan adı boş olamaz."});
    const local=exactLocal(query);
    let c=local?{valid:true,display_name_tr:local.display_name,scientific_name:local.scientific_name,rank:local.rank||"",broad_group:!!local.broad_group}:await aiResolveName(query);
    if(!c.valid) return res.status(422).json({error:c.reason||"Karşı taraf hayvan adı çözülemedi.",alternatives:c.alternatives||[]});
    const verified=await gbifMatch(c.scientific_name);
    if(!verified) return res.status(422).json({error:"Karşı taraf hayvanı bulundu ancak zoolojik takson doğrulanamadı."});
    const animal={query,display_name:c.display_name_tr||local?.display_name||verified.scientific_name,scientific_name:verified.scientific_name,full_name:verified.full_name,rank:verified.rank||c.rank||"",broad_group:!!c.broad_group,taxonomy_source:"GBIF",taxon_key:verified.key};
    const profile=await habitatProfile(animal),compatible=scoreLocations(profile);
    if(!compatible.length) return res.status(422).json({error:"Karşı taraf hayvanı için güvenilir doğal habitat eşleşmesi bulunamadı."});
    const token=crypto.randomUUID();
    animalCache.set(token,{animal,profile,locationIds:new Set(compatible.map(x=>x.id)),createdAt:Date.now()});
    const tierMeta=defaultTierMeta(animal.scientific_name);
    res.json({token,animal,profile,tier_meta:tierMeta,locations:compatible});
  }catch(e){
    console.error(e);
    res.status(500).json({error:e?.message||"Karşı taraf çözümleme hatası."});
  }
});

const animalInfoCache=new Map();
async function gbifIucnCategory(taxonKey){
  if(!taxonKey) return null;
  try{
    const r=await fetch(`https://api.gbif.org/v1/species/${encodeURIComponent(taxonKey)}/iucnRedListCategory`);
    if(!r.ok) return null;
    const j=await r.json();
    return j?.category || j?.code || j?.name || null;
  }catch{return null}
}
function extractResponseJson(text){
  const raw=String(text||"").trim().replace(/^```json\s*/i,"").replace(/```$/i,"").trim();
  try{return JSON.parse(raw)}catch{}
  const a=raw.indexOf("{"),b=raw.lastIndexOf("}");
  if(a>=0&&b>a){try{return JSON.parse(raw.slice(a,b+1))}catch{}}
  return null;
}
async function researchedAnimalInfo(animal, mode="short"){
  const cacheKey=`${normalize(animal.scientific_name)}:${mode}`;
  if(animalInfoCache.has(cacheKey)) return animalInfoCache.get(cacheKey);
  const iucn=await gbifIucnCategory(animal.taxon_key);
  const detailed=mode==="detailed";
  const prompt=`Doğrulanmış zoolojik takson hakkında güncel, yüksek doğruluklu bilgi kartı hazırla.
HAYVAN:
Türkçe/görünen ad: ${animal.display_name}
Bilimsel ad: ${animal.scientific_name}
Takson rankı: ${animal.rank||"bilinmiyor"}
GBIF taxon key: ${animal.taxon_key||"yok"}
GBIF üzerinden IUCN kategori ipucu: ${iucn||"bulunamadı"}
KAYNAK KALİTESİ KURALI:
1. Taksonomi için GBIF / Catalogue of Life / WoRMS gibi birincil taksonomi kaynaklarını önceliklendir.
2. Koruma durumu için IUCN Red List veya bu bilgiyi aktaran güvenilir birincil kurumları önceliklendir.
3. Boy, ağırlık, yaşam süresi, diyet, dağılım ve davranış için Smithsonian, NOAA Fisheries, USFWS, Australian Museum, Natural History Museum, Animal Diversity Web, San Diego Zoo Wildlife Alliance ve üniversite/müze kaynaklarını tercih et.
4. Genel bloglar, SEO siteleri, kullanıcı içerikleri, forumlar ve kaynaksız sayfaları kullanma.
5. Bir sayı kaynaklar arasında değişiyorsa tek kesin sayı verme; tipik aralık ver ve sex/yaş/coğrafya farkını kısaca belirt.
6. Esaret yaşam süresi ile doğadaki yaşam süresini karıştırma.
7. Hız, ısırma kuvveti, tehlike seviyesi gibi internette çok yanlış aktarılan verilerde güvenilir doğrulama yoksa "güvenilir standart değer yok" de.
8. İnsan için tehlike alanında sansasyon yapma: doğal davranış, belgelenmiş risk ve temas koşullarını kısa ve nötr anlat.
9. Bilinmeyen bilgiyi uydurma. "Güvenilir veri sınırlı" yaz.
10. Bilgi güncelliği ve tür düzeyi doğruluğu, popülerlikten daha önemlidir.
MOD: ${detailed?"DETAYLI":"KISA"}
${detailed ? `
Detaylı modda şu başlıkların mümkün olanlarını doldur:
taksonomi, genel tanım, vücut uzunluğu, omuz/yükseklik, ağırlık, cinsiyet farkları, yaşam süresi (doğa/esaret ayrı), diyet, avlar, avcılar/doğal düşmanlar, habitat, coğrafi dağılım, günlük aktivite, sosyal yapı, hareket/hız, yüzme, tırmanma, uçma varsa, duyular, avlanma yöntemi, savunma, üreme, gebelik/kuluçka, yavru sayısı, cinsel olgunluk, iletişim, zekâ/problem çözme, mevsimsel davranış/göç, insan için risk, insanla etkileşim, ekosistemdeki rol, adaptasyonlar, koruma durumu, başlıca tehditler ve 8-12 ilginç özellik.
` : `
Kısa modda telefon ekranında rahat okunacak öz bir kart oluştur:
boy/uzunluk, ağırlık, yaşam süresi, beslenme, habitat, dağılım, aktivite, hareket kabiliyeti/hız (yalnız güvenilir ise), insan için risk, koruma durumu ve 5-7 ilginç özellik.
`}
WEB ARAŞTIRMASI YAP ve en az 3 güvenilir kaynaktan çapraz kontrol et.
SADECE geçerli JSON döndür. URL uydurma.
JSON ŞEMASI:
{
 "animal_name":"...",
 "scientific_name":"...",
 "mode":"short|detailed",
 "confidence":"yüksek|orta",
 "confidence_note":"çok kısa",
 "facts":{
   "length":"...",
   "height":"...",
   "weight":"...",
   "lifespan_wild":"...",
   "lifespan_captivity":"...",
   "diet":"...",
   "prey":"...",
   "predators":"...",
   "habitat":"...",
   "distribution":"...",
   "activity":"...",
   "social_structure":"...",
   "speed_movement":"...",
   "swimming":"...",
   "climbing":"...",
   "senses":"...",
   "hunting":"...",
   "defense":"...",
   "reproduction":"...",
   "gestation_incubation":"...",
   "offspring":"...",
   "maturity":"...",
   "communication":"...",
   "intelligence":"...",
   "migration_seasonality":"...",
   "human_risk":"...",
   "human_interaction":"...",
   "ecological_role":"...",
   "adaptations":"...",
   "conservation_status":"...",
   "threats":"..."
 },
 "interesting_facts":["..."],
 "sources":[
   {"name":"kurum/kaynak adı","domain":"alan adı","used_for":"hangi bilgi için"}
 ],
 "cautions":["varsa veri belirsizliği veya tür/cinsiyet/coğrafya farkı"]
}`;
  const r=await getOpenAI().responses.create({
    model:process.env.OPENAI_RESEARCH_MODEL||process.env.OPENAI_MODEL||"gpt-5.6",
    reasoning:{effort:detailed?"high":"medium"},
    tools:[{type:"web_search"}],
    input:prompt
  });
  const j=extractResponseJson(r.output_text);
  if(!j) throw new Error("Araştırma sonucu yapılandırılmış bilgiye dönüştürülemedi.");
  j.mode=mode;
  j.gbif_iucn_hint=iucn;
  j.researched_at=new Date().toISOString();
  if(!Array.isArray(j.sources)) j.sources=[];
  if(!Array.isArray(j.interesting_facts)) j.interesting_facts=[];
  if(!Array.isArray(j.cautions)) j.cautions=[];
  animalInfoCache.set(cacheKey,j);
  return j;
}
app.post("/api/animal/info",async(req,res)=>{
  try{
    const token=String(req.body?.animalToken||"").trim();
    const mode=req.body?.mode==="detailed"?"detailed":"short";
    const cache=animalCache.get(token);
    if(!cache) return res.status(400).json({error:"Önce hayvanı doğrula."});
    const info=await researchedAnimalInfo(cache.animal,mode);
    res.json(info);
  }catch(e){
    console.error(e);
    res.status(500).json({error:e?.message||"Hayvan bilgisi alınamadı."});
  }
});
app.get("/api/video-formats",(req,res)=>{
  res.json(videoFormats.map(f=>({id:f.id,name:f.name,emoji:f.emoji,lengths:f.lengths,description:f.description})));
});
app.get("/api/video-formats/:id",(req,res)=>{
  const f=videoFormats.find(x=>x.id===req.params.id);
  if(!f) return res.status(404).json({error:"Video formatı bulunamadı."});
  res.json(f);
});
app.get("/api/visual-modes",(req,res)=>{
  res.json(visualModes);
});

app.get("/api/vs-templates",(req,res)=>{
  const format=String(req.query.format||"").trim();
  const items=format?vsTemplates.filter(x=>(x.formats||[]).includes(format)):vsTemplates;
  res.json(items.map(t=>({id:t.id,label:t.label,formats:t.formats,description:t.description,rules:t.rules})));
});

app.get("/api/real-media/providers",(req,res)=>{
  res.json({providers:providerStatus(),config:realMediaConfig});
});
app.get("/api/real-media/browse",async(req,res)=>{
  try{
    const provider=String(req.query.provider||'').toLowerCase();
    const kind=String(req.query.kind||'image').toLowerCase();
    const q=String(req.query.q||'').trim();
    const page=clampInt(req.query.page,1,100000,1);
    const perPage=clampInt(req.query.per_page,3,80,24);
    if(!q) return res.status(400).json({error:'Arama kelimesi gerekli.'});
    if(!['pexels','pixabay','wikimedia','openverse'].includes(provider)) return res.status(400).json({error:'Geçersiz medya sağlayıcısı.'});
    if(!['image','video'].includes(kind)) return res.status(400).json({error:'Tür image veya video olmalı.'});
    let result;
    if(provider==='pexels') result=kind==='video'?await searchPexelsVideos(q,perPage,page):await searchPexelsPhotos(q,perPage,page);
    else if(provider==='pixabay') result=kind==='video'?await searchPixabayVideos(q,perPage,page):await searchPixabayImages(q,perPage,page);
    else if(provider==='wikimedia') result=await searchWikimediaMedia(q,perPage,kind);
    else { if(kind==='video') return res.status(400).json({error:'Openverse video araması sağlamıyor; fotoğraf seç.'}); result=await searchOpenverseImages(q,perPage,page); }
    res.json({provider,kind,query:q,...result,provider_rules:providerStatus()[provider]});
  }catch(e){console.error(e);res.status(500).json({error:e?.message||'Medya kütüphanesi taranamadı.'})}
});

app.post("/api/real-media/search",async(req,res)=>{
  try{
    const d=req.body||{};
    const cache=animalCache.get(String(d.animalToken||"").trim());
    if(!cache) return res.status(400).json({error:"Önce hayvanı doğrula."});
    const location=locationById.get(String(d.locationId||""));
    if(!location) return res.status(400).json({error:"Geçerli mekan seç."});
    if(!cache.locationIds.has(location.id)) return res.status(422).json({error:"Seçilen mekan bu hayvan için doğal habitat filtresinden geçmiyor."});
    const requestedKind=["image","video","both"].includes(d.mediaKind)?d.mediaKind:"both";
    const compareType=d.compareType||"single";
    let opponentAnimal=null;
    if(compareType==='animal_vs_animal'){
      const op=animalCache.get(String(d.opponentAnimalToken||"").trim());
      if(!op) return res.status(400).json({error:"İkinci hayvan doğrulanmamış."});
      opponentAnimal=op.animal;
    }else if(compareType==='human_vs_animal'){
      opponentAnimal={display_name:'İnsan',scientific_name:'Homo sapiens'};
    }
    const layers=buildRealMediaLayers({animal:cache.animal,profile:cache.profile,location,videoType:d.videoType||'Shorts',compareType,opponentAnimal,requestedKind});
    const output=[];
    for(const layer of layers){
      const targetAnimal = layer.id.startsWith('side_b_') ? opponentAnimal : (layer.id.startsWith('human_') ? {display_name:'İnsan',scientific_name:'Homo sapiens'} : cache.animal);
      const results=await searchLayerAssets(layer, targetAnimal, location, layer.kind==='both'?requestedKind:layer.kind);
      output.push({...layer,queries:buildLayerQueries(layer,targetAnimal,location),results});
    }
    const warnings=[];
    const ps=providerStatus();
    if(!ps.pexels.enabled) warnings.push('Pexels kapalı: PEXELS_API_KEY eklenirse gerçek fotoğraf ve video çeşitliliği artar.');
    if(!ps.pixabay.enabled) warnings.push('Pixabay kapalı: PIXABAY_API_KEY eklenirse gerçek fotoğraf ve video çeşitliliği artar.');
    if(output.every(x=>!x.results.length)) warnings.push('Hiç gerçek medya sonucu alınamadı. API anahtarlarını ve sorgu koşullarını kontrol et.');
    res.json({
      searched_at:new Date().toISOString(),
      provider_status:ps,
      animal:cache.animal,
      opponent:opponentAnimal,
      location,
      media_kind:requestedKind,
      compare_type:compareType,
      layers:output,
      warnings
    });
  }catch(e){
    console.error(e);
    res.status(500).json({error:e?.message||'Gerçek medya araması başarısız.'});
  }
});

const SYSTEM_PROMPT=`Sen bu kullanıcı için çalışan profesyonel YouTube hayvan-video üretim otomasyonusun.
ZORUNLU DOĞRULUK KURALLARI:
1. Gerçek dünya biyolojisi, ekoloji ve fiziksel gerçeklik zorunludur.
2. Hayvan taksonomik olarak doğrulanmış olmalıdır. Geniş takson verilmişse rastgele bir tür seçme.
3. Mekan yalnızca habitat filtresinden geçmiş seçeneklerden alınır.
4. Boy, ağırlık, hız, yaşam süresi, ısırma kuvveti, gebelik/kuluçka, yavru sayısı, koruma durumu veya tehlike seviyesi gibi sayısal bilgileri uydurma.
5. Kaynaklar arasında sayı değişiyorsa tek kesin sayı yerine bağlamlı aralık kullan.
6. Doğadaki yaşam süresi ile esaret yaşam süresini karıştırma.
7. İnternette popüler olan efsaneyi doğrulanmış gerçek gibi yazma.
8. Güvenilir veri yoksa açıkça "güvenilir standart veri sınırlı" yaklaşımını kullan.
9. Kullanıcının verdiği komut biyolojik gerçeklikle çelişiyorsa gerçekliği koru.
10. AI ile oluşturulan bir sahneyi gerçek kamera kaydı, tarihsel kayıt veya belgelenmiş olay gibi sunma.
11. Gerçek medya istendiğinde yalnızca telifsiz / açık lisanslı / güvenilir serbest kullanım kaynağı ailelerini öner. Canlı medya çekim katmanı kullanılıyorsa sağlayıcı sonucunu temel al.
12. Filigranlı, marka logolu veya telif riski yüksek resmi içerikleri önerme.
YAZIM VE ÜSLUP:
- Türkçe yazım ve noktalama hatalarını düzelt.
- Hayvanın Türkçe adı ve bilimsel adı tutarlı kullanılsın.
- Gereksiz tekrar, çelişki ve anlamsız sıfatlardan kaçın.
- Kısa videoda cümleler kısa, konuşma diline uygun ve seslendirmede akıcı olsun.
- Kullanıcının hedef kitlesi verilmişse tempo ve açıklama seviyesini buna göre ayarla.
GÖRSEL GERÇEKLİK:
- Doğal anatomi, doğru uzuv sayısı, doğru kürk/pul/tüy deseni ve gerçek habitat.
- Hayvanın beden oranları sahneler arasında değişmesin.
- Aynı bireyin devam ettiği sahnelerde karakter sürekliliği korunmalı.
- Kullanıcı istemedikçe görsel üzerinde metin, logo veya filigran olmasın.
- Shorts varsayılan 9:16, uzun video varsayılan 16:9.
VİDEO AKIŞI:
Seçilen formatın özel kurallarını genel kurallardan sonra uygula.
Shorts'ta ilk 1-2 saniyede güçlü hook kullan; hook cevabı tamamen vermesin.
Uzun videoda bölüm geçişlerinde merakı yeniden kur.
CTA doğal akışta ve kısa olsun.
ÇIKTI:
1. Video özeti
2. Hook
3. Zaman kodlu sahne akışı
4. Seslendirme metni
5. Görsel içerik paketi (seçilen moda göre: gerçek telifsiz medya planı veya AI görsel/video prompt paketi)
6. Kamera/kurgu/geçiş/SFX
7. Altyazı önerisi
8. CTA
9. Başlık
10. Açıklama
11. Etiketler
12. Thumbnail / kapak hook paketi
13. İlk 3 saniye planı
14. Doğruluk kontrol notları
15. Üretim kontrol listesi.`;
app.post("/api/generate",async(req,res)=>{
  try{
    const d=req.body||{},cache=animalCache.get(d.animalToken);
    if(!cache) return res.status(400).json({error:"Hayvanı önce doğrula."});
    const loc=locationById.get(d.locationId);
    if(!loc||!cache.locationIds.has(d.locationId)) return res.status(422).json({error:"Seçilen mekan bu hayvanın doğal habitat seçenekleri arasında değil."});
    const format=videoFormats.find(x=>x.id===d.videoFormatId);
    if(!format) return res.status(400).json({error:"Geçerli bir video formatı seç."});

    const isLong = d.videoType==="Uzun Video";
    const lengthMode=isLong?"long":"short";
    if(!format.lengths.includes(lengthMode)) return res.status(422).json({error:"Bu video formatı seçilen video uzunluğunu desteklemiyor."});

    let visualMediaMode = "real";
    if(isLong){
      visualMediaMode = "real";
    }else{
      if(!["real","ai"].includes(d.visualMediaMode)) return res.status(400).json({error:"Shorts için görsel içerik modunu seç."});
      visualMediaMode = d.visualMediaMode;
    }

    const formatRules=format.prompt_rules.map((x,i)=>`${i+1}. ${x}`).join("\n");
    const profile = cache.profile || {};
    const waterRelation = profile.water_relation || "mixed";

    const isAnimalVsAnimal = format.id==="comparison";
    const isHumanVsAnimal = format.id==="human_vs_animal";
    let compareContext = "";
    let compareVisualBrief = "";
    let opponentSummary = null;
    let vsTemplateContext = "";

    if(isAnimalVsAnimal){
      const opponentToken = String(d.opponentAnimalToken||"").trim();
      if(!opponentToken) return res.status(400).json({error:"Hayvan vs hayvan için ikinci hayvanı seç."});
      const opponentCache = animalCache.get(opponentToken);
      if(!opponentCache) return res.status(400).json({error:"Karşı taraf hayvanını yeniden doğrula."});
      if(normalize(opponentCache.animal.scientific_name)===normalize(cache.animal.scientific_name)){
        return res.status(422).json({error:"Karşılaştırma için iki farklı hayvan seç."});
      }
      const overlap = compareOverlap(cache, opponentCache, d.locationId);
      const naturalEncounter = overlap.selectedForOpponent || overlap.overlapCount > 0;
      const encounterNote = naturalEncounter
        ? "İki hayvan arasında habitat kesişimi var veya seçilen mekan her ikisi için de doğal olarak savunulabilir. Karşılaştırma görsellerinde sınırlı ortak çerçeve kullanılabilir; yine de gereksiz şiddetten kaçın."
        : "Doğal ortak karşılaşma zayıf. Doğrudan kapışma kurgulama; split-screen, ölçek kıyası, ayrı habitat kadrajı ve nötr karşılaştırma yaklaşımı kullan.";
      opponentSummary = opponentCache.animal;
      compareContext = `KARŞILAŞTIRMA TÜRÜ: HAYVAN VS HAYVAN
TARAF A: ${cache.animal.display_name} (${cache.animal.scientific_name})
TARAF B: ${opponentCache.animal.display_name} (${opponentCache.animal.scientific_name})
TARAF B TAKSON RANKI: ${opponentCache.animal.rank||"bilinmiyor"}
TARAF B GENİŞ TAKSON MU: ${opponentCache.animal.broad_group?"evet":"hayır"}
TARAF B EKOLOJİ/HABİTAT İPUCU: ${opponentCache.profile?.reason||""}
DOĞAL KARŞILAŞMA DEĞERLENDİRMESİ: ${encounterNote}`;
      compareVisualBrief = visualMediaMode==="ai"
        ? `KARŞILAŞTIRMA GÖRSEL KURALI:
- AI paketini 3 bölüme ayır:
  1) TARAF A SOLO SAHNELERİ: 4 sahne
  2) TARAF B SOLO SAHNELERİ: 3 sahne
  3) KARŞILAŞTIRMA SAHNELERİ: 3 sahne
- Karşılaştırma sahnelerinde ortak/doğal temas zayıfsa aynı karede fiziksel mücadele kurma. Split-screen, ölçek kıyası, hız/beden/güç kıyası ve nötr karşılaştırma kadrajları kullan.
- Her iki hayvan için de ayrı gerçekçi anatomi, doğru habitat ve davranış kullan.`
        : `KARŞILAŞTIRMA GÖRSEL KURALI:
- Gerçek medya paketini 3 bölüme ayır:
  1) TARAF A SOLO MEDYA: 4 öneri
  2) TARAF B SOLO MEDYA: 4 öneri
  3) KARŞILAŞTIRMA / KOLAJ / SPLIT-SCREEN MEDYA: 4 öneri
- Aynı fotoğraf/video tipini tekrar etme.
- Karşılaştırma önerilerinde gerekirse split-screen, ölçü referansı ve ayrı habitat kadrajları kullan.`;
    } else if(isHumanVsAnimal){
      compareContext = `KARŞILAŞTIRMA TÜRÜ: İNSAN VS HAYVAN
TARAF A: İnsan (genel yetişkin insan referansı)
TARAF B: ${cache.animal.display_name} (${cache.animal.scientific_name})
KURAL: Sahte yaşama şansı yüzdesi verme. Güvenli, nötr ve karşılaştırmalı anlat.`;
      compareVisualBrief = visualMediaMode==="ai"
        ? `KARŞILAŞTIRMA GÖRSEL KURALI:
- AI paketini 3 bölüme ayır:
  1) HAYVAN SOLO SAHNELERİ: 4 sahne
  2) İNSAN REFERANS SAHNELERİ: 3 sahne
  3) KARŞILAŞTIRMA SAHNELERİ: 3 sahne
- Gereksiz şiddet, grafik zarar veya gerçekçi saldırı anı üretme.
- İnsan ile hayvanı çoğunlukla ölçek, hız, güç, çeviklik, çevre farkı veya güvenli mesafeli aynı ortam kıyasıyla karşılaştır.`
        : `KARŞILAŞTIRMA GÖRSEL KURALI:
- Gerçek medya paketini 3 bölüme ayır:
  1) HAYVAN SOLO MEDYA: 5 öneri
  2) İNSAN REFERANS MEDYA: 3 öneri
  3) KARŞILAŞTIRMA / KOLAJ / SPLIT-SCREEN: 4 öneri
- İnsan tarafında telifsiz, yüzü zorunlu değilse anonim veya genel yetişkin outdoor referansları tercih et.`;
    }

    if(isAnimalVsAnimal || isHumanVsAnimal){
      const vsTemplateId = String(d.vsTemplateId||"").trim();
      if(!vsTemplateId) return res.status(400).json({error:"Karşılaştırma videosu için bir VS şablonu seç."});
      const tpl = vsTemplates.find(x=>x.id===vsTemplateId);
      if(!tpl) return res.status(400).json({error:"Geçerli bir VS şablonu seç."});
      if(!(tpl.formats||[]).includes(format.id)) return res.status(422).json({error:"Seçilen VS şablonu bu karşılaştırma formatına uygun değil."});
      vsTemplateContext = `VS ŞABLONU: ${tpl.label}
AÇIKLAMA: ${tpl.description}
ŞABLON KURALLARI:
${tpl.rules.map((x,i)=>`${i+1}. ${x}`).join("\n")}
ÇIKTI İSTEĞİ: Başta ayrı bir "HOOK İÇİN EN GÜÇLÜ 3 SAHNE" bölümü ver. Bu bölüm karşılaştırmanın en viral 3 açılış karesini kısa maddelerle sunsun.`;
    }

    const realMediaBrief = `GÖRSEL İÇERİK MODU: GERÇEK FOTOĞRAF + VİDEO
- Yalnızca gerçek, telifsiz veya açık lisanslı medya kullanım planı üret.
- Filigransız ve yasal olarak güvenli kaynak aileleri öner: ${visualModes.source_families.join(", ")}.
- Çıktıda ayrı bir "Gerçek Görsel İçerik Paketi" bölümü oluştur.
- Önce 1 kısa "Viral Öncelik Notu" yaz.
- Bu bölümde 10 farklı medya ihtiyacı ver. Her madde birbirinden belirgin şekilde farklı olsun. Her madde için:
  1) medya türü (fotoğraf/video),
  2) sahne/eylem,
  3) istenen kadraj,
  4) yön/oran (${isLong?"16:9 yatay":"9:16 dikey"}),
  5) TR arama kelimeleri,
  6) EN arama kelimeleri,
  7) önerilen kaynak aileleri,
  8) lisans/filigran notu,
  9) viral_güç_skoru (100 üzerinden),
 10) farklılık_notu (neden diğerlerinden farklı olduğu).
- Sahneler seçilen hayvanın biyolojisine ve habitatına uygun olmalı.
- En güçlü ve en dikkat çekici içerikleri üst sıralara koy.
- Aynı eylem, aynı kadraj ve aynı kompozisyon tekrar etmemeli.
- Kullanıcıya doğrudan telifli içerik aratacak resmî marka/ajans kaynakları verme.`;

    const aiMediaBrief = `GÖRSEL İÇERİK MODU: YAPAY ZEKA FOTOĞRAF + VİDEO
- Çıktıda ayrı bir "AI Görsel/Video Üretim Paketi" bölümü oluştur.
- Önce 1 kısa "Viral Seçim Mantığı" paragrafı yaz.
- 10 farklı sahne üret. Her sahne biyolojik olarak mümkün, habitatla uyumlu, güçlü ve birbirinden belirgin şekilde farklı olsun.
- Aynı eylem, aynı kadraj ve aynı kompozisyonu tekrar etme.
- İlk 3 sahne en yüksek dikkat çekme potansiyelli olsun.
- Şu viral boyutları dengeli kullan: ${visualStrategy.viral_dimensions.join(", ")}.
- Şu tekrar engeli kurallarını uygula: ${visualStrategy.dedupe_rules.join(" | ")}.
- Sahneleri hayvanın doğal hareket repertuarından seç. Su canlılarında yüzme, dalış, avı izleme, yön değiştirme, yüzeye çıkma gibi; kara canlılarında yürüme, koşma, avı takip etme, dinlenme, çevreyi koklama, tırmanma (uygunsa), sıçrama (uygunsa) gibi eylemler kullan.
- Her sahne için 3 açı ver:
  A) yakın plan detay,
  B) yan/profil orta plan,
  C) geniş sinematik çevre planı.
- Her açı için 2 ayrı prompt yaz:
  1) IMAGE PROMPT
  2) VIDEO PROMPT
- Toplamda 10 sahne x 3 açı = 30 açı seti oluşmalı.
- Her sahne için ayrıca şu kısa alanları da ver:
  action_label,
  viral_güç_skoru,
  neden_güçlü,
  tekrar_engeli_notu.
- Tüm promptlarda şunları açıkça belirt: hayvan adı, bilimsel doğruluk, yaş/grup durumu uygunsa, mekan, ışık, lens/kadraj, hareket, anatomi, doku detayları, filigransız, yazısız, hiper-gerçekçi/fotogerçekçi.
- AI sahnelerini gerçek kamera kaydı gibi anlatma.`;

    const visualBrief = isLong ? realMediaBrief : (visualMediaMode==="ai" ? aiMediaBrief : realMediaBrief);

    const userPrompt=`VİDEO UZUNLUĞU: ${d.videoType||"Shorts"}
VİDEO FORMATI: ${format.name}
FORMAT AÇIKLAMASI: ${format.description}
FORMAT ÖZEL KURALLARI:
${formatRules}
KONU: ${d.topic||""}
HAYVAN: ${cache.animal.display_name}
BİLİMSEL TAKSON: ${cache.animal.scientific_name}
TAKSON RANKI: ${cache.animal.rank||"bilinmiyor"}
GENİŞ TAKSON MU: ${cache.animal.broad_group?"evet":"hayır"}
MEKAN: ${loc.name}
ANA MEKAN DALI: ${loc.category_name}
HABİTAT ETİKETLERİ: ${loc.habitat_tags.join(", ")}
SU İLİŞKİSİ / EKOLOJİK İPUCU: ${waterRelation}
SÜRE: ${d.duration||""}
HEDEF: ${d.goal||"yüksek izleyici tutma ve etkileşim"}
TON: ${d.tone||"merak uyandırıcı ve temiz"}
GÖRSEL STİL: ${d.visualStyle||"fotogerçekçi"}
SAHNE SAYISI: ${d.sceneCount||"süreye göre optimize et"}
HEDEF KİTLE: ${d.audience||"25-44 yaş"}
EK KOMUT: ${d.extra||"yok"}
${compareContext ? compareContext + "\n" : ""}${vsTemplateContext ? vsTemplateContext + "\n" : ""}${visualBrief}
${compareVisualBrief ? compareVisualBrief + "\n" : ""}OTOMATİK TIKLATMA PAKETİ:
- 3 alternatif başlık üret. Kurallar: ${clickPackage.title_rules.join(" | ")}
- 3 alternatif thumbnail hook paketi üret. Kurallar: ${clickPackage.thumbnail_rules.join(" | ")}
- Ayrı bir "İLK 3 SANİYE PLANI" bölümü üret. Kurallar: ${clickPackage.first3sec_rules.join(" | ")}
- Başlıklar, thumbnail hookları ve ilk 3 saniye planı seçilen format, hayvan ve hedef kitleyle tam uyumlu olsun.
${compareVisualBrief ? compareVisualBrief + "\n" : ""}GÖRSEL STRATEJİ İLKELERİ:
- Viral boyutlar: ${visualStrategy.viral_dimensions.join(", ")}
- Tekrar engeli: ${visualStrategy.dedupe_rules.join(" | ")}
- Karşılaştırma ilkeleri: ${comparisonModes.principles.join(" | ")}

SON KONTROL:
- Format ile konu çelişiyorsa format kurallarını ve gerçekliği koru.
- Geniş takson verilmişse türe özgü sayı/özellik uydurma.
- Tüm sayısal iddiaları ihtiyatlı kullan.
- AI görsel promptlarında hayvan + mekan + zaman + kamera + ışık + anatomi tutarlılığını açık yaz.
- Gerçek medya modunda yalnızca telifsiz veya açık lisanslı kaynak aileleri öner.
- Çıktıyı başlıklarla temiz, kısa ve uygulanabilir üret.
- "Başlık" bölümünde 3 alternatif ver ve en iyi olanı ayrıca işaretle.
- "Thumbnail / kapak hook paketi" bölümünde 3 ayrı öneri ver; her birinde ana görsel fikir, kapak üstü kısa yazı ve psikolojik merak açısı olsun.
- "İlk 3 saniye planı" bölümünü 0.0-0.7 sn / 0.7-1.8 sn / 1.8-3.0 sn biçiminde açıkça yaz.`;

    const r=await getOpenAI().responses.create({
      model:process.env.OPENAI_MODEL||"gpt-5.6",
      reasoning:{effort:"medium"},
      input:[{role:"system",content:SYSTEM_PROMPT},{role:"user",content:userPrompt}]
    });

    res.json({
      output:r.output_text,
      animal:cache.animal,
      opponent:opponentSummary,
      location:loc,
      format:{id:format.id,name:format.name},
      visual_mode:visualMediaMode,
      video_type:d.videoType
    });
  }catch(e){
    console.error(e);
    res.status(500).json({error:e?.message||"Üretim hatası."});
  }
});
const animalGroups=JSON.parse(fs.readFileSync(path.join(__dirname,"public","animal_groups.json"),"utf8")).groups;
const groupKeyCache=new Map();



app.get("/api/setup/profiles",(req,res)=>{
  const store=readProfiles();
  const aliases=Object.entries(store.profiles).map(([alias,p])=>({
    alias,
    openai_configured:!!p.openai,
    pexels_configured:!!p.pexels,
    pixabay_configured:!!p.pixabay,
    active:store.active_alias===alias
  }));
  res.json({active_alias:store.active_alias,profiles:aliases});
});
app.post("/api/setup/profile",(req,res)=>{
  try{
    const alias=cleanAlias(req.body?.alias||"");
    if(!alias) return res.status(400).json({error:"Geçerli bir takma ad gir."});
    const store=readProfiles();
    if(store.profiles[alias]) return res.status(409).json({error:"Bu takma ad zaten kayıtlı."});
    const p={
      openai:String(req.body?.openai||"").trim(),
      pexels:String(req.body?.pexels||"").trim(),
      pixabay:String(req.body?.pixabay||"").trim(),
      created_at:new Date().toISOString()
    };
    if(!p.openai) return res.status(400).json({error:"Profil oluşturmak için OpenAI anahtarı gerekli."});
    store.profiles[alias]=p;
    store.active_alias=alias;
    writeProfiles(store);
    activateProfile(alias);
    // keep .env in sync with active profile for normal restart behavior
    saveEnvValues({OPENAI_API_KEY:p.openai,PEXELS_API_KEY:p.pexels,PIXABAY_API_KEY:p.pixabay});
    res.json({saved:true,alias,active:true});
  }catch(e){console.error(e);res.status(500).json({error:"Takma ad profili kaydedilemedi."})}
});
app.post("/api/setup/activate",(req,res)=>{
  const alias=cleanAlias(req.body?.alias||"");
  if(!alias) return res.status(400).json({error:"Takma ad boş olamaz."});
  const ok=activateProfile(alias);
  if(!ok) return res.status(404).json({error:"Bu takma adla kayıtlı profil bulunamadı."});
  const store=readProfiles(),p=store.profiles[alias];
  saveEnvValues({OPENAI_API_KEY:p.openai,PEXELS_API_KEY:p.pexels,PIXABAY_API_KEY:p.pixabay});
  res.json({active:true,alias});
});

app.get("/api/setup/status",(req,res)=>{
  const status={
    openai_configured:!!String(process.env.OPENAI_API_KEY||"").trim(),
    pexels_configured:!!String(process.env.PEXELS_API_KEY||"").trim(),
    pixabay_configured:!!String(process.env.PIXABAY_API_KEY||"").trim(),
    env_file_exists:fs.existsSync(ENV_FILE),
    setup_locked:!!String(process.env.OPENAI_API_KEY||"").trim() && !!String(process.env.PEXELS_API_KEY||"").trim() && !!String(process.env.PIXABAY_API_KEY||"").trim(),
    active_alias:readProfiles().active_alias
  };
  res.json(status);
});
app.post("/api/setup/keys",(req,res)=>{
  try{
    const body=req.body||{};
    const current={
      OPENAI_API_KEY:String(process.env.OPENAI_API_KEY||"").trim(),
      PEXELS_API_KEY:String(process.env.PEXELS_API_KEY||"").trim(),
      PIXABAY_API_KEY:String(process.env.PIXABAY_API_KEY||"").trim()
    };
    const incoming={
      OPENAI_API_KEY:String(body.openai||"").trim(),
      PEXELS_API_KEY:String(body.pexels||"").trim(),
      PIXABAY_API_KEY:String(body.pixabay||"").trim()
    };
    // Existing keys cannot be overwritten from the browser setup form.
    const updates={};
    for(const [key,val] of Object.entries(incoming)){
      if(val && !current[key]) updates[key]=val;
    }
    if(!Object.keys(updates).length){
      return res.status(409).json({error:"Yeni kaydedilecek eksik anahtar yok. Mevcut anahtarlar güvenlik nedeniyle tarayıcıdan üzerine yazılmaz."});
    }
    saveEnvValues(updates);
    refreshOpenAIClient();
    res.json({
      saved:true,
      openai_configured:!!String(process.env.OPENAI_API_KEY||"").trim(),
      pexels_configured:!!String(process.env.PEXELS_API_KEY||"").trim(),
      pixabay_configured:!!String(process.env.PIXABAY_API_KEY||"").trim()
    });
  }catch(e){
    console.error(e);
    res.status(500).json({error:"API anahtarları kaydedilemedi."});
  }
});

app.get("/api/health",async(req,res)=>{
  const checks={
    server:true,
    openai_api_key_present:!!process.env.OPENAI_API_KEY,
    model:process.env.OPENAI_MODEL||"gpt-5.6",
    files:{
      locations:locations.length===500,
      video_formats:Array.isArray(videoFormats)&&videoFormats.length>0,
      animal_groups:Array.isArray(animalGroups)&&animalGroups.length>0,
      vs_templates:Array.isArray(vsTemplates)&&vsTemplates.length>0
    },
    gbif:false,
    providers:providerStatus()
  };
  try{
    const r=await fetch("https://api.gbif.org/v1/species/suggest?q=Panthera%20onca&limit=1");
    checks.gbif=r.ok;
  }catch{}
  checks.real_media_photo_ready=checks.providers.wikimedia?.enabled===true;
  checks.real_media_video_ready=checks.providers.pexels?.enabled===true||checks.providers.pixabay?.enabled===true;
  const ready=checks.server&&checks.openai_api_key_present&&checks.files.locations&&checks.files.video_formats&&checks.files.animal_groups&&checks.files.vs_templates&&checks.gbif&&checks.real_media_photo_ready;
  res.status(ready?200:503).json({ready,checks});
});

const featuredAnimalMap=new Map();
for(const g of animalGroups){
  for(const item of g.featured){
    featuredAnimalMap.set(normalize(item.scientific_name),{
      group_id:g.id,
      group_name:g.name,
      content_tier:item.content_tier||"medium",
      content_label:item.content_label||"• İyi",
      content_score:item.content_score||65,
      featured_rank:item.rank||null
    });
  }
}
const ideaCache=new Map();
function defaultTierMeta(scientificName){
  return featuredAnimalMap.get(normalize(scientificName)) || {content_tier:"niche",content_label:"◦ Niş",content_score:52,featured_rank:null,group_id:null,group_name:null};
}
async function taxonKeyFor(name){
  if(groupKeyCache.has(name)) return groupKeyCache.get(name);
  const m=await gbifMatch(name);
  const key=m?.key||null;
  if(key) groupKeyCache.set(name,key);
  return key;
}
app.get("/api/animal-groups",(req,res)=>res.json(animalGroups.map(g=>({id:g.id,name:g.name,emoji:g.emoji,featured_count:g.featured.length}))));
app.get("/api/animal-groups/:id/featured",(req,res)=>{
  const g=animalGroups.find(x=>x.id===req.params.id);
  if(!g) return res.status(404).json({error:"Hayvan grubu bulunamadı."});
  res.json({id:g.id,name:g.name,emoji:g.emoji,featured:g.featured});
});
app.get("/api/animal-groups/:id/search",async(req,res)=>{
  try{
    const g=animalGroups.find(x=>x.id===req.params.id);
    if(!g) return res.status(404).json({error:"Hayvan grubu bulunamadı."});
    const q=String(req.query.q||"").trim();
    const limit=Math.min(Math.max(Number(req.query.limit)||30,1),50);
    const offset=Math.max(Number(req.query.offset)||0,0);
    if(!q) return res.json({results:g.featured.slice(offset,offset+limit),source:"featured",end:offset+limit>=g.featured.length});
    const merged=[],seen=new Set();
    for(const taxonName of g.taxa){
      const key=await taxonKeyFor(taxonName);
      if(!key) continue;
      const url=`https://api.gbif.org/v1/species/search?q=${encodeURIComponent(q)}&highertaxon_key=${encodeURIComponent(key)}&limit=${limit}`;
      const r=await fetch(url);
      if(!r.ok) continue;
      const j=await r.json();
      for(const x of (j.results||[])){
        const sci=x.scientificName||x.canonicalName;
        if(!sci) continue;
        const k=normalize(sci);
        if(seen.has(k)) continue;
        seen.add(k);
        merged.push({
          display_name:x.vernacularName||x.canonicalName||sci,
          scientific_name:sci,
          rank:x.rank||"",
          taxon_key:x.key||x.nubKey||null,
          source:"GBIF"
        });
      }
    }
    res.json({results:merged.slice(0,limit),source:"GBIF",end:merged.length<limit});
  }catch(e){res.status(500).json({error:e?.message||"Grup araması başarısız."})}
});
app.post("/api/animal/ideas",async(req,res)=>{
  try{
    const token=String(req.body?.animalToken||"").trim();
    const cache=animalCache.get(token);
    if(!cache) return res.status(400).json({error:"Önce hayvanı doğrula."});
    const animal=cache.animal;
    const tierMeta=defaultTierMeta(animal.scientific_name);
    const key=normalize(animal.scientific_name);
    if(ideaCache.has(key)) return res.json(ideaCache.get(key));
    const prompt=`Sen YouTube Shorts ve hayvan kanalı stratejisti olarak çalışıyorsun.
Kullanıcı için seçilen hayvan hakkında yüksek dikkat çekme potansiyelli 5 video konusu üret.
Amaç: Türkçe kısa video içerikleri için merak uyandırıcı, tıklatıcı ama gerçek bilgiye dayalı konu açıları bulmak.
Konu başlıkları kısa, güçlü ve uygulanabilir olsun.
Her fikir kısa videoya uygun olsun.
Hayvan: ${animal.display_name}
Bilimsel ad: ${animal.scientific_name}
Takson rankı: ${animal.rank||"bilinmiyor"}
İçerik potansiyeli etiketi: ${tierMeta.content_label}
Aşağıdaki JSON dışında hiçbir şey döndürme:
{
  "animal_display_name":"...",
  "scientific_name":"...",
  "content_label":"...",
  "content_score":0,
  "summary":"1 kısa cümle",
  "ideas":[
    {
      "title":"kısa başlık",
      "hook":"1-2 saniyelik güçlü giriş cümlesi",
      "angle":"videonun ana merak açısı",
      "why_clicks":"neden dikkat çeker"
    }
  ]
}`;
    const r=await getOpenAI().responses.create({
      model:process.env.OPENAI_MODEL||"gpt-5.6",
      reasoning:{effort:"medium"},
      input:prompt
    });
    let j;
    try{
      j=JSON.parse(r.output_text.trim().replace(/^```json\s*/i,"").replace(/```$/i,""));
    }catch{
      return res.status(500).json({error:"Fikirler JSON olarak çözülemedi."});
    }
    if(!Array.isArray(j.ideas)) j.ideas=[];
    j.ideas=j.ideas.slice(0,5);
    j.content_label=tierMeta.content_label;
    j.content_score=tierMeta.content_score;
    j.content_tier=tierMeta.content_tier;
    j.group_name=tierMeta.group_name;
    ideaCache.set(key,j);
    res.json(j);
  }catch(e){console.error(e);res.status(500).json({error:e?.message||"Hayvan fikirleri üretilemedi."})}
});
const port=process.env.PORT||3000;app.listen(port,()=>console.log(`Panel hazır: http://localhost:${port}`));