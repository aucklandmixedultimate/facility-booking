import { useState } from "react";
import { councilState, allPhases, fmtDay, fmtRange, COUNCIL_LINKS, COUNCIL_CONTACTS } from "../councilSeasons.js";
import { Badge, COUNCIL_APPLICATION_FEE, STATUS_META, venueFacilities } from "./core.jsx";
import { isLegacyStatus } from "../statuses.js";
import cornwallMap from "../assets/cornwall-park-fields.webp";
// One numbered step in About → How to Book.
export function AboutStep({ n, col, title, children }) {
  return (
    <div style={{ display:"flex", gap:12, alignItems:"flex-start", marginBottom:12 }}>
      <div style={{ minWidth:28, height:28, padding:"0 6px", boxSizing:"border-box", borderRadius:14, background:col, color:"#fff", fontWeight:700, fontSize:12,
        display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0 }}>{n}</div>
      <div>
        <div style={{fontWeight:600,fontSize:14,color:"#0f172a"}}>{title}</div>
        <div style={{fontSize:13,color:"#475569",marginTop:2}}>{children}</div>
      </div>
    </div>);
}
export function AboutTab() {
  const card = { background:"#fff", border:"1px solid #e2e8f0", borderRadius:12, padding:"20px 24px", marginBottom:16 };
  const h2 = { margin:"0 0 12px", fontSize:16, fontWeight:700, color:"#0f172a" };
  const step = { display:"flex", gap:12, alignItems:"flex-start", marginBottom:12 };
  const stepNum = (col) => ({
    minWidth:28, height:28, padding:"0 6px", boxSizing:"border-box", borderRadius:14, background:col, color:"#fff",
    fontWeight:700, fontSize:12, display:"flex", alignItems:"center", justifyContent:"center", flexShrink:0
  });
  const arrow = { textAlign:"center", color:"#94a3b8", fontSize:18, margin:"4px 0 4px 14px" };
  const link = { color:"#2563eb", textDecoration:"underline" };
  const [howTab, setHowTab] = useState("gtec");
  const tabBtn = (id, label) => (
    <button key={id} onClick={()=>setHowTab(id)} style={{padding:"6px 12px",borderRadius:8,border:"1.5px solid",borderColor:howTab===id?"#0f172a":"#e2e8f0",
      background:howTab===id?"#0f172a":"#fff",color:howTab===id?"#fff":"#475569",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:"inherit"}}>{label}</button>);
  const cs = councilState(), today = new Date();
  const phases = allPhases().filter(p => p.to >= new Date(today.getTime() - 30*86400000)).slice(0, 12);
  const councilTimes = (
    <>
      <h3 style={{margin:"16px 0 8px",fontSize:14,fontWeight:700,color:"#0f172a"}}>Council booking windows</h3>
      <div style={{fontSize:13,color:"#475569",marginBottom:8}}>
        <b>Now:</b> {cs.now.length ? cs.now.map(p=>p.label).join(" · ") : "between phases"}.{" "}
        <b>Next:</b> {cs.next.map(p=>`${p.label} (${p.approx?"≈ ":""}${fmtDay(p.from)})`).join(" · ")}.
      </div>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
        <thead><tr style={{textAlign:"left",color:"#64748b"}}><th style={{padding:"4px 6px"}}>Window</th><th style={{padding:"4px 6px"}}>Dates</th></tr></thead>
        <tbody>{phases.map((p,i)=>{ const on = p.from<=today && today<=p.to; return (
          <tr key={i} style={{background:on?"#ecfdf5":p.season==="winter"?"#f0f9ff":"#fffbeb",fontWeight:on?700:400}}>
            <td style={{padding:"4px 6px"}}>{p.season==="winter"?"❄":"☀"} {p.label}{on?" · now":""}</td>
            <td style={{padding:"4px 6px",whiteSpace:"nowrap"}}>{fmtRange(p)}</td></tr>); })}</tbody>
      </table>
      <p style={{margin:"8px 0 0",fontSize:12,color:"#94a3b8"}}>
        ≈ = estimated from this year's published dates (same week of the year). The council publishes each season's dates on its{" "}
        <a href={COUNCIL_LINKS[0].url} target="_blank" rel="noopener noreferrer" style={link}>How to book our sports facilities</a> page
        and in parksbookings news emails. Winter seasonal applications usually open mid-December and close early February; the winter season starts early April.
      </p>
      <h3 style={{margin:"16px 0 8px",fontSize:14,fontWeight:700,color:"#0f172a"}}>Council contacts</h3>
      <div style={{fontSize:13,color:"#475569"}}>
        <a href={`mailto:${COUNCIL_CONTACTS.email}`} style={link}>{COUNCIL_CONTACTS.email}</a> · {COUNCIL_CONTACTS.phone} (general line).
        Parks booking coordinators by region: {COUNCIL_CONTACTS.coordinators.map(c=>`${c.region} (${c.role})`).join(" · ")}. AMUA holds their direct details.
      </div>
      <h3 style={{margin:"16px 0 8px",fontSize:14,fontWeight:700,color:"#0f172a"}}>Useful council links</h3>
      <ul style={{margin:0,paddingLeft:18,fontSize:13,color:"#475569"}}>
        {COUNCIL_LINKS.map(l=><li key={l.url}><a href={l.url} target="_blank" rel="noopener noreferrer" style={link}>{l.label}</a></li>)}
      </ul>
    </>);
  return (
    <div style={{maxWidth:720,margin:"0 auto"}}>
      <div style={card}>
        <h2 style={h2}>How to Book</h2>
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:14}}>
          {tabBtn("gtec","Cornwall Park · CPSA / GTEC · St Cuthberts")}
          {tabBtn("council","🏛 Council fields")}
          {tabBtn("private","◆ Council + private operator")}
          {tabBtn("community","🏫 Community facilities")}
        </div>
        {howTab==="council"&&(<>
          <p style={{margin:"0 0 12px",fontSize:13,color:"#475569"}}>
            Auckland Council parks are booked through the council's online services portal. AMUA batches its bookers' council fields into one application,
            and the council charges <b>${COUNCIL_APPLICATION_FEE} per field per application</b>, split between the bookers sharing each field. Pick fields on the{" "}
            <a href={import.meta.env.BASE_URL+"vetting.html"} style={link}>Council / Community fields</a> page (📅 Book → save them as 📌 Active bookings); they then appear here under
            Provider → 📍 Location.
          </p>
          <h3 style={{margin:"12px 0 8px",fontSize:14,fontWeight:700,color:"#0f172a"}}>Approval Process</h3>
          <p style={{margin:"0 0 12px",fontSize:13,color:"#475569"}}>
            AMUA applies as the organisation, and each application names the bookers and teams using the fields, with their player numbers. <b>You're the key holder</b> for
            the fields you book, so your name and phone must be on file (📇 Fill in council contact on the booking form, or User menu → 📇 My council contact).
            The booking form also asks for the players you expect and whether it's training or competition; grade and notes for the council are optional.
          </p>
          <AboutStep n="1/6" col="#6366f1" title="Submit booking request">Book the dates and times on your active council field. Status <Badge status="pending_amua" wf="council"/>.</AboutStep>
          <div style={arrow}>↓</div>
          <AboutStep n="2/6" col="#14b8a6" title="AMUA applies to the council">AMUA reviews it and adds it to the next council application (with other bookers' fields at that park). Status <Badge status="council_apply" wf="council"/>.</AboutStep>
          <div style={arrow}>↓</div>
          <AboutStep n="3/6" col="#0d9488" title="Awaiting the council's decision">Once AMUA submits, the application number and your share of the fee are recorded. Status <Badge status="council_pending" wf="council"/>.</AboutStep>
          <div style={arrow}>↓</div>
          <AboutStep n="4/6" col="#ea580c" title="Council offer">The council's parks booking coordinator offers the fields; AMUA confirms (or withdraws) with the council. Status <Badge status="council_action" wf="council"/>.</AboutStep>
          <div style={arrow}>↓</div>
          <AboutStep n="5/6" col="#65a30d" title="Council grants it">The council confirms the booking and AMUA allocates the granted fields to the bookers who applied. Status <Badge status="council_granted" wf="council"/>.</AboutStep>
          <div style={arrow}>↓</div>
          <AboutStep n="6/6" col="#22c55e" title="Allocated">You're emailed when your field is allocated (<Badge status="approved" wf="council"/>), or why not (<Badge status="rejected" wf="council"/>) if the council declines or the fields went to other bookings. Seasonal applications are allocated after the application window closes; casual applications are processed once seasonal ones are settled.</AboutStep>
          {councilTimes}
        </>)}
        {howTab==="private"&&(<>
          <p style={{margin:"0 0 12px",fontSize:13,color:"#475569"}}>
            Some council parks are run by a club, trust or other operator (◆ on the Council / Community fields map). The operator has to agree first, and the council still issues the permit.
            Some grounds can only be booked through a particular club: for example <b>BOOKING ONLY AVAILABLE THROUGH Ellerslie Ultimate Club</b> (Michaels Ave) or <b>TPU</b> (Fergusson Domain).
            GTEC's grounds (Cornwall Park, Orakei, Shore Road) are <b>BOOKING ONLY AVAILABLE THROUGH AMUA</b> — use the CPSA / GTEC process.
          </p>
          <h3 style={{margin:"12px 0 8px",fontSize:14,fontWeight:700,color:"#0f172a"}}>Approval Process</h3>
          <AboutStep n="1/8" col="#6366f1" title="Submit booking request">Book on your active field at that park. Status <Badge status="pending_amua" wf="council_private"/>.</AboutStep>
          <div style={arrow}>↓</div>
          <AboutStep n="2/8" col="#a855f7" title="AMUA asks the operator">AMUA contacts the club or operator (their contact is on the Council fields page) for permission. Status <Badge status="op_permission" wf="council_private"/>.</AboutStep>
          <div style={arrow}>↓</div>
          <AboutStep n="3/8" col="#14b8a6" title="AMUA applies to the council">With the operator's agreement, the field goes into the next council application. Status <Badge status="council_apply" wf="council_private"/>.</AboutStep>
          <div style={arrow}>↓</div>
          <AboutStep n="4/8" col="#0d9488" title="Awaiting the council's decision">The application number and your share of the $10-per-field fee are recorded. Status <Badge status="council_pending" wf="council_private"/>.</AboutStep>
          <div style={arrow}>↓</div>
          <AboutStep n="5/8" col="#ea580c" title="Council offer">The council offers the fields; AMUA confirms (or withdraws) with the council. Status <Badge status="council_action" wf="council_private"/>.</AboutStep>
          <div style={arrow}>↓</div>
          <AboutStep n="6/8" col="#65a30d" title="Council grants it">The council confirms and AMUA allocates the granted fields to the bookers who applied. Status <Badge status="council_granted" wf="council_private"/>.</AboutStep>
          <div style={arrow}>↓</div>
          <AboutStep n="7/8" col="#7c3aed" title="Confirm with the operator">After the council's permit, AMUA confirms the arrangements (keys, lights) with the operator. Status <Badge status="op_confirm" wf="council_private"/>.</AboutStep>
          <div style={arrow}>↓</div>
          <AboutStep n="8/8" col="#22c55e" title="Approved">The booking is confirmed: <Badge status="approved" wf="council_private"/> (or <Badge status="rejected"/> if the operator or council declines).</AboutStep>
          {councilTimes}
        </>)}
        {howTab==="community"&&(<>
          <p style={{margin:"0 0 12px",fontSize:13,color:"#475569"}}>
            Schools and trusts that hire their fields to AMUA, such as Auckland Normal Intermediate ($20/hr), St Cuthbert's College and Sacred Heart College.
            Add the field on the <a href={import.meta.env.BASE_URL+"vetting.html"} style={link}>Council / Community fields</a> map (📅 Book → save it as a 📌 Active booking),
            then book dates here under Provider → 📍 Location. These are <b>booked only through AMUA</b>.
          </p>
          <h3 style={{margin:"12px 0 8px",fontSize:14,fontWeight:700,color:"#0f172a"}}>Approval Process</h3>
          <AboutStep n="1/4" col="#6366f1" title="Submit booking request">Book the dates and times on your active community field. Status <Badge status="pending_amua" wf="community"/>.</AboutStep>
          <div style={arrow}>↓</div>
          <AboutStep n="2/4" col="#ca8a04" title="AMUA reviews the facility contact">Only before AMUA's first request to a facility: the contact details are checked. Status <Badge status="contact_review" wf="community"/>.</AboutStep>
          <div style={arrow}>↓</div>
          <AboutStep n="3/4" col="#2563eb" title="AMUA requests the slot">AMUA asks the facility by email from its own inbox. Status <Badge status="community_request" wf="community"/>.</AboutStep>
          <div style={arrow}>↓</div>
          <AboutStep n="4/4" col="#22c55e" title="Facility confirms">Once the facility confirms, the booking is <Badge status="approved" wf="community"/> (or <Badge status="rejected"/>).</AboutStep>
          <p style={{margin:"8px 0 0",fontSize:12,color:"#94a3b8"}}>The booking app only ever emails bookers. Messages for facilities, operators or the council are drafted to AMUA's inbox and sent by AMUA from Gmail.</p>
        </>)}
        {howTab==="gtec"&&(<>
        <p style={{margin:"0 0 12px",fontSize:13,color:"#475569"}}>
          Bookings at Cornwall Park are managed through GTEC (Grammar TEC).
          AMUA (Auckland Mixed Ultimate Association) acts as a facilitating body and can submit booking requests on your behalf.
          You can also submit directly using the{" "}
          <a href="https://www.grammartec.co.nz/viewform/499414" target="_blank" rel="noopener noreferrer" style={link}>GTEC field hire form</a>.
        </p>
        <figure style={{margin:"0 0 12px"}}>
          <a href={cornwallMap} target="_blank" rel="noopener noreferrer" title="Open the map full size">
            <img src={cornwallMap} alt="Map of the Cornwall Park fields: CPSA fields #1–#3 with pitch spots 1–6, St Cuthbert's College field 10, and the ARL lower area 7–9"
              style={{width:"100%",height:"auto",borderRadius:10,border:"1px solid #e2e8f0",display:"block"}}/>
          </a>
          <figcaption style={{fontSize:12,color:"#475569",marginTop:6,lineHeight:1.6}}>
            <b style={{color:"#15803d"}}>Green — CPSA fields #1–#3</b> (booked through GTEC), with the numbered pitch spots 1–6 marked inside them.{" "}
            <b style={{color:"#c2410c"}}>10 — St Cuthbert&apos;s College</b> field, next to the CPSA fields.{" "}
            <b style={{color:"#a16207"}}>7–9 — ARL</b>, the privately run lower field area.
          </figcaption>
        </figure>
        <p style={{margin:"0 0 12px",fontSize:13,color:"#475569"}}>
          <b>St Cuthbert&apos;s College</b> (field 10 on the map) is hired by AMUA directly from the school, not through GTEC:
          it has its own purchase order and doesn&apos;t go through the GTEC steps below. AMUA arranges bookings there with the
          school — ask AMUA if you&apos;d like a slot.
        </p>
        <h3 style={{margin:"12px 0 8px",fontSize:14,fontWeight:700,color:"#0f172a"}}>Approval Process</h3>
        <div style={step}>
          <div style={stepNum("#6366f1")}>1/4</div>
          <div>
            <div style={{fontWeight:600,fontSize:14,color:"#0f172a"}}>Submit booking request</div>
            <div style={{fontSize:13,color:"#475569",marginTop:2}}>Fill in the booking form with your group name, facility, date, time, and purpose. Your request is saved with status <Badge status="pending_amua"/>.</div>
          </div>
        </div>
        <div style={arrow}>↓</div>
        <div style={step}>
          <div style={stepNum("#f59e0b")}>2/4</div>
          <div>
            <div style={{fontWeight:600,fontSize:14,color:"#0f172a"}}>AMUA reviews your request</div>
            <div style={{fontSize:13,color:"#475569",marginTop:2}}>AMUA checks availability and eligibility. If accepted, the booking is queued for submission to GTEC — status becomes <Badge status="queued_cpsa" vendor="GTEC"/>. If there is a conflict or issue, AMUA may reject or request revision.</div>
          </div>
        </div>
        <div style={arrow}>↓</div>
        <div style={step}>
          <div style={stepNum("#0ea5e9")}>3/4</div>
          <div>
            <div style={{fontWeight:600,fontSize:14,color:"#0f172a"}}>AMUA submits to GTEC</div>
            <div style={{fontSize:13,color:"#475569",marginTop:2}}>AMUA lodges the request with GTEC using the{" "}
              <a href="https://www.grammartec.co.nz/viewform/499414" target="_blank" rel="noopener noreferrer" style={link}>GTEC field hire form</a>.
              Status becomes <Badge status="pending_cpsa" vendor="GTEC"/>. You can also contact GTEC directly — AMUA can co-sign as the responsible party.
            </div>
          </div>
        </div>
        <div style={arrow}>↓</div>
        <div style={step}>
          <div style={stepNum("#22c55e")}>4/4</div>
          <div>
            <div style={{fontWeight:600,fontSize:14,color:"#0f172a"}}>GTEC decision &amp; reconciliation</div>
            <div style={{fontSize:13,color:"#475569",marginTop:2}}>
              Once AMUA receives verbal confirmation from GTEC, the booking is marked <Badge status="approved"/> (or <Badge status="rejected"/> if declined) — accept/reject only applies while a booking has not yet been reconciled against GTEC's published schedule. When AMUA later syncs the official GTEC schedule, an approved booking that matches GTEC's record exactly is promoted to <Badge status="cpsa_confirmed"/> — confirming that what you booked is what GTEC has on file. If anything differs (time, duration or facility), the booking is flagged <Badge status="cpsa_review_needed"/> instead, and AMUA will triage the discrepancy. Bookings with a 🌐 marker in the calendar are GTEC-confirmed.
            </div>
          </div>
        </div>
        </>)}
      </div>

      <div style={card}>
        <h2 style={h2}>About Admin Bookings</h2>
        <p style={{margin:"0 0 8px",fontSize:13,color:"#475569"}}>
          Bookings shown with a grey/admin tag are imported from the{" "}
          <a href="https://www.carltonjuniorsrugby.co.nz/venue-hire-fields-1/field-calendar" target="_blank" rel="noopener noreferrer" style={link}>Carlton Juniors Rugby field calendar</a>.
          These represent existing field bookings and block-outs that may affect availability.
        </p>
        <p style={{margin:0,fontSize:13,color:"#94a3b8"}}>
          Note: the CJR calendar covers sports field bookings only. It does <strong>not</strong> include availability of function rooms or meeting rooms.
        </p>
      </div>

      <div style={card}>
        <h2 style={h2}>Hiring Rates</h2>
        <p style={{margin:"0 0 12px",fontSize:13,color:"#475569"}}>Rates are set per facility and time of day. Contact AMUA for current rates.</p>
        <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
          {venueFacilities().map(f=>(
            <div key={f.id} style={{display:"flex",alignItems:"center",gap:8,background:"#f8fafc",border:"1px solid #e2e8f0",borderRadius:8,padding:"10px 14px",flex:"1 1 180px"}}>
              <span style={{width:10,height:10,borderRadius:"50%",background:f.color,display:"inline-block",flexShrink:0}}/>
              <span style={{fontWeight:600,fontSize:13,color:"#0f172a"}}>{f.name}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={card}>
        <h2 style={h2}>Status Guide</h2>
        <p style={{fontSize:13,color:"#475569",margin:"0 0 10px"}}>Every booking moves through the same kinds of stage. Where a stage involves the facility's vendor it's named on the booking — e.g. <Badge status="pending_cpsa" vendor="GTEC"/> for Cornwall Park, or <Badge status="pending_cpsa" vendor="St Cuthbert's"/> — and reads "vendor" here.</p>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {Object.entries(STATUS_META).filter(([k])=>!isLegacyStatus(k)).map(([k,v])=>(
            <div key={k} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 10px",background:v.bg,border:`1px solid ${v.border}`,borderRadius:8,flexWrap:"wrap"}}>
              <span style={{width:8,height:8,borderRadius:"50%",background:v.dot,flexShrink:0}}/>
              <span style={{fontWeight:600,fontSize:13,color:v.text}}>{v.label}</span>
              {v.desc&&<span style={{fontSize:12,color:"#475569"}}>— {v.desc}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}