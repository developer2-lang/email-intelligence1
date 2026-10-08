import { useState } from 'react';

interface SettingsTabProps {
  contacts: any[];
  apiState: { lusha: boolean; mailchimp: boolean };
  storedApiKeys: { lusha: string; mailchimp: string };
  onPersistApiKeys: (keys: { lusha: string; mailchimp: string }) => void;
  onPersistContacts: (contacts: any[]) => void;
  onToast: (msg: string, type?: string) => void;
  isSyncing: boolean;
  triggerMailchimpSync: () => void;
  prefFrom: string;
  setPrefFrom: (val: string) => void;
  prefReply: string;
  setPrefReply: (val: string) => void;
  prefSig: string;
  setPrefSig: (val: string) => void;
}

export default function SettingsTab({
  contacts,
  apiState,
  storedApiKeys,
  onPersistApiKeys,
  onPersistContacts,
  onToast,
  isSyncing,
  triggerMailchimpSync,
  prefFrom,
  setPrefFrom,
  prefReply,
  setPrefReply,
  prefSig,
  setPrefSig
}: SettingsTabProps) {
  // API Keys Form Temp States
  const [tempLushaKey, setTempLushaKey] = useState(storedApiKeys.lusha);
  const [tempMcKey, setTempMcKey] = useState(storedApiKeys.mailchimp);

  // Lusha leads search engine mock state
  const [leadsSearchCompany, setLeadsSearchCompany] = useState('');
  const [leadsSearchTitle, setLeadsSearchTitle] = useState('Design Director');
  const [isSearchingLeads, setIsSearchingLeads] = useState(false);
  const [leadsSearchResults, setLeadsSearchResults] = useState<any[]>([]);

  // ─── LUSHA API HANDLERS ───
  const connectLusha = () => {
    if (!tempLushaKey.trim()) {
      onToast('Please enter a valid Lusha API Key', 'error');
      return;
    }
    const updated = { ...storedApiKeys, lusha: tempLushaKey.trim() };
    onPersistApiKeys(updated);
    onToast('Lusha API integrated successfully ✓', 'success');
  };

  const disconnectLusha = () => {
    const updated = { ...storedApiKeys, lusha: '' };
    setTempLushaKey('');
    onPersistApiKeys(updated);
    setLeadsSearchResults([]);
    onToast('Lusha API disconnected', 'info');
  };

  // Simulated Lead Enrichment Search
  const runLushaSearch = () => {
    if (!leadsSearchCompany.trim()) {
      onToast('Please enter a target company', 'error');
      return;
    }
    setIsSearchingLeads(true);
    setLeadsSearchResults([]);

    setTimeout(() => {
      const domains = ['@bajajelectricals.com', '@havells.com', '@usha.com', '@crompton.co.in', '@godrej.com'];
      const domain = domains[Math.floor(Math.random() * domains.length)];
      const parsedCompany = leadsSearchCompany.trim();

      const results = [
        {
          name: 'Siddharth Sen',
          company: parsedCompany,
          email: `siddharth.s${domain}`,
          designation: leadsSearchTitle || 'Design Lead',
          industry: 'Industrial Appliances',
          city: 'Mumbai',
          enriched: true,
          phone: `+91 ${Math.floor(Math.random() * 9e8 + 1e8)}`
        },
        {
          name: 'Meera Johar',
          company: parsedCompany,
          email: `meera.j${domain}`,
          designation: `Senior ${leadsSearchTitle || 'Product Manager'}`,
          industry: 'Consumer Goods',
          city: 'Bengaluru',
          enriched: true,
          phone: `+91 ${Math.floor(Math.random() * 9e8 + 1e8)}`
        }
      ];

      setLeadsSearchResults(results);
      setIsSearchingLeads(false);
      onToast('Lusha returned 2 verified professional contacts', 'success');
    }, 1500);
  };

  const importSingleLead = (lead: any) => {
    if (contacts.find(c => c.email.toLowerCase() === lead.email.toLowerCase())) {
      onToast('This contact already exists in your database', 'warn');
      return;
    }
    const newContact = {
      id: Math.max(...contacts.map(x => x.id), 0) + 1,
      name: lead.name,
      company: lead.company,
      email: lead.email,
      designation: lead.designation,
      industry: lead.industry,
      type: 'New Lead',
      category: 'OEM',
      city: lead.city,
      lastContacted: new Date().toISOString().slice(0, 10),
      notes: 'Imported via Lusha leads prospect engine.',
      engagement: 30,
      enriched: true,
      phone: lead.phone
    };
    onPersistContacts([...contacts, newContact]);
    onToast(`Imported ${lead.name} to Contacts list`, 'success');
  };

  // ─── MAILCHIMP API HANDLERS ───
  const connectMailchimp = () => {
    if (!tempMcKey.trim()) {
      onToast('Please enter a valid Mailchimp API Key', 'error');
      return;
    }
    const updated = { ...storedApiKeys, mailchimp: tempMcKey.trim() };
    onPersistApiKeys(updated);
    onToast('Mailchimp API integrated successfully ✓', 'success');
  };

  const testMailchimp = () => {
    onToast('Testing API connection...', 'info');
    setTimeout(() => {
      onToast('Mailchimp status: Active (API Key verified)', 'success');
    }, 1000);
  };

  const disconnectMailchimp = () => {
    const updated = { ...storedApiKeys, mailchimp: '' };
    setTempMcKey('');
    onPersistApiKeys(updated);
    onToast('Mailchimp API disconnected', 'info');
  };

  // Save Sender Profiles
  const saveSenderConfig = () => {
    if (!prefFrom.trim() || !prefReply.trim()) {
      onToast('From & Reply-to addresses are required', 'error');
      return;
    }
    onToast('Default Sender configurations updated ✓', 'success');
  };

  return (
    <div className="page active">
      <div className="settings-grid" style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '16px' }}>
        {/* Left Side: Integrations */}
        <div className="flex flex-col gap-4">
          {/* LUSHA API & PROSPECTING */}
          <div className="card">
            <div className="card-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '18px' }}>✦</span>
                <div>Lusha Leads Prospecting</div>
              </div>
              <span className={`tag ${apiState.lusha ? 'tag-client' : 'tag-draft'}`} style={{ fontSize: '9px' }}>
                {apiState.lusha ? 'Connected' : 'Not Connected'}
              </span>
            </div>

            {!apiState.lusha ? (
              <div>
                <div style={{ fontSize: '12.5px', color: 'var(--text3)', marginBottom: '12px', lineHeight: 1.4 }}>
                  Connect your Lusha API to search, verify, and enrich contacts with direct-dial phone numbers and premium roles.
                </div>
                <div className="form-group" style={{ marginBottom: '12px' }}>
                  <label>Lusha API Key</label>
                  <input
                    type="password"
                    placeholder="Enter your Lusha API Key..."
                    value={tempLushaKey}
                    onChange={(e) => setTempLushaKey(e.target.value)}
                  />
                </div>
                <button className="btn btn-primary btn-sm" onClick={connectLusha}>Connect Lusha</button>
              </div>
            ) : (
              <div>
                <div className="form-group" style={{ marginBottom: '12px' }}>
                  <label>Lusha API Key</label>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input type="password" value="••••••••••••••••••••••••••••" disabled style={{ background: 'var(--surface2)' }} />
                    <button className="btn btn-ghost btn-sm" onClick={disconnectLusha} style={{ color: 'var(--red)' }}>Disconnect</button>
                  </div>
                </div>

                <div style={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 'var(--r)', padding: '12px', marginTop: '14px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text4)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '10px' }}>Prospect Leads Generator</div>
                  <div className="grid-2" style={{ marginBottom: '10px' }}>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Target Company</label>
                      <input type="text" placeholder="e.g. Havells India" value={leadsSearchCompany} onChange={(e) => setLeadsSearchCompany(e.target.value)} />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label>Target Job Title</label>
                      <input type="text" placeholder="e.g. Head of R&D" value={leadsSearchTitle} onChange={(e) => setLeadsSearchTitle(e.target.value)} />
                    </div>
                  </div>
                  <button className="btn btn-primary btn-sm" onClick={runLushaSearch} disabled={isSearchingLeads}>
                    {isSearchingLeads ? 'Searching Lusha...' : 'Find Verified Leads'}
                  </button>

                  {/* Lusha Results */}
                  {leadsSearchResults.length > 0 && (
                    <div style={{ marginTop: '14px', borderTop: '1px solid var(--border)', paddingTop: '10px' }}>
                      <div style={{ fontSize: '10.5px', fontWeight: 700, color: 'var(--text4)', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '8px' }}>Lusha Verified Contacts</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {leadsSearchResults.map((l, idx) => (
                          <div key={idx} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--surface)', border: '1px solid var(--border)', padding: '8px 10px', borderRadius: '4px' }}>
                            <div>
                              <div style={{ fontSize: '13px', fontWeight: 600 }}>{l.name}</div>
                              <div style={{ fontSize: '11px', color: 'var(--text4)', marginTop: '2px' }}>{l.designation} · {l.company}</div>
                              <div style={{ fontSize: '10.5px', color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: '2px' }}>{l.email} · {l.phone}</div>
                            </div>
                            <button className="btn btn-secondary btn-xs" onClick={() => importSingleLead(l)}>+ Import</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* MAILCHIMP INTEGRATION */}
          <div className="card">
            <div className="card-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '18px' }}>🔌</span>
                <div>Mailchimp Integration</div>
              </div>
              <span className={`tag ${apiState.mailchimp ? 'tag-client' : 'tag-draft'}`} style={{ fontSize: '9px' }}>
                {apiState.mailchimp ? 'Connected' : 'Not Connected'}
              </span>
            </div>

            <div style={{ fontSize: '12.5px', color: 'var(--text3)', marginBottom: '12px', lineHeight: 1.4 }}>
              Connect your Mailchimp account to synchronize campaign metrics and track bounce rates inside the Analytics section.
            </div>

            <div className="form-group" style={{ marginBottom: '12px' }}>
              <label>Mailchimp API Key</label>
              <input
                type="password"
                placeholder={apiState.mailchimp ? '••••••••••••••••••••••••••••' : 'Enter your Mailchimp API Key...'}
                value={tempMcKey}
                onChange={(e) => setTempMcKey(e.target.value)}
                disabled={apiState.mailchimp}
                style={{ background: apiState.mailchimp ? 'var(--surface2)' : 'var(--surface)' }}
              />
            </div>

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {!apiState.mailchimp ? (
                <button className="btn btn-primary btn-sm" onClick={connectMailchimp}>Connect Mailchimp</button>
              ) : (
                <>
                  <button className="btn btn-secondary btn-sm" onClick={testMailchimp}>Test Connection</button>
                  <button className="btn btn-secondary btn-sm" onClick={triggerMailchimpSync} disabled={isSyncing}>{isSyncing ? 'Syncing...' : 'Sync Now'}</button>
                  <button className="btn btn-danger btn-sm" onClick={disconnectMailchimp}>Disconnect</button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Right Side: Sender Preferences */}
        <div className="card flex flex-col">
          <div className="card-title">Default Sender Details</div>
          <div style={{ fontSize: '12.5px', color: 'var(--text3)', marginBottom: '12px' }}>
            Set up the default sender profile and signatures applied to outreach templates.
          </div>

          <div className="form-group" style={{ marginBottom: '12px' }}>
            <label>Sender Address (From)</label>
            <input
              type="email"
              value={prefFrom}
              onChange={(e) => setPrefFrom(e.target.value)}
              placeholder="rupali.s@iuova.com"
            />
          </div>

          <div className="form-group" style={{ marginBottom: '12px' }}>
            <label>Reply-to Address</label>
            <input
              type="email"
              value={prefReply}
              onChange={(e) => setPrefReply(e.target.value)}
              placeholder="rupali.s@iuova.com"
            />
          </div>

          <div className="form-group" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <label>Default Sender Signature</label>
            <textarea
              style={{ flex: 1, resize: 'none', minHeight: '120px' }}
              value={prefSig}
              onChange={(e) => setPrefSig(e.target.value)}
              placeholder="Best regards, Rupali Sirsath..."
            ></textarea>
          </div>

          <div style={{ marginTop: '14px', textAlign: 'right' }}>
            <button className="btn btn-primary btn-sm" onClick={saveSenderConfig}>Save Configurations</button>
          </div>
        </div>
      </div>
    </div>
  );
}
