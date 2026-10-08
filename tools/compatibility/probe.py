#!/usr/bin/env python3
"""Guarded extension and synthetic persistence probes; never writes a pass receipt."""

import argparse
import hashlib
import json
from pathlib import Path
import sys
import time
from urllib.parse import urlsplit
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from playground.bridge import Bridge
from playground.identity import canonical, load_json

INSTALL = r'''
const [path, expectedId, done] = arguments;
(async () => {
  const {AddonManager} = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
  const file = Components.classes['@mozilla.org/file/local;1'].createInstance(Components.interfaces.nsIFile);
  file.initWithPath(path);
  const install = await AddonManager.getInstallForFile(file);
  if (install.addon?.id !== expectedId) throw new Error('Unexpected package ID');
  await new Promise((resolve,reject) => {
    install.addListener({onInstallEnded:resolve,onInstallFailed:()=>reject(new Error('Install failed')),
      onDownloadFailed:()=>reject(new Error('Download failed')),onInstallCancelled:()=>reject(new Error('Install cancelled'))});
    install.install();
  });
  const addon = await AddonManager.getAddonByID(expectedId);
  done({id:addon.id,version:addon.version,active:addon.isActive,
    app_disabled:addon.appDisabled,user_disabled:addon.userDisabled,signed_state:addon.signedState});
})().catch(e=>done({error:String(e)}));
'''

EXTENSIONS = r'''
const [ids,done]=arguments;
(async()=>{
  const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
  const result=[];
  for(const id of ids){
    const a=await AddonManager.getAddonByID(id);
    result.push(a?{id:a.id,version:a.version,active:a.isActive,signed_state:a.signedState}:{id,missing:true});
  }
  done(result);
})().catch(e=>done({error:String(e)}));
'''

PAGE_STATE = r'''
let cookieOk=false, counter=null;
try {
  cookieOk=document.cookie.split('; ').includes('zen_probe=synthetic-v1');
  counter=localStorage.getItem('zen-probe-counter');
} catch (_) { /* A newly opened about:blank tab has not reached the fixture yet. */ }
return {url:location.href,title:document.title,
  cookie_ok:cookieOk,counter,ready:document.readyState};
'''


def selected_content(bridge):
    """Bind Marionette to the selected tab, including tabs opened through chrome."""
    handle = bridge.client.script('return ChromeUtils.importESModule("chrome://remote/content/shared/NavigableManager.sys.mjs").NavigableManager.getIdForBrowser(gBrowser.selectedBrowser);')
    bridge.client.command('Marionette:SetContext', {'value':'content'})
    bridge.client.command('WebDriver:SwitchToWindow', {'handle':handle})


def packages(repo):
    root = repo / '.zen-local' / 'extensions'
    inventory = load_json(root / 'inventory.json')
    if inventory.get('packages_only') is not True or inventory.get('copied_profile_data') is not False:
        raise ValueError('Extension inventory must contain package bytes only')
    result = inventory['extensions']
    for item in result:
        path = canonical(item['package'])
        if path.parent != root or path.suffix != '.xpi':
            raise ValueError('Package must be inside the extension package directory')
        if hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']:
            raise ValueError('Package checksum mismatch')
        with zipfile.ZipFile(path) as archive:
            manifest = json.loads(archive.read('manifest.json'))
        identity = manifest.get('browser_specific_settings', manifest.get('applications', {}))
        if identity.get('gecko', {}).get('id') != item['id'] or manifest['version'] != item['version']:
            raise ValueError('Package ID/version mismatch')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('install-extensions','extensions','seed','persistence'))
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--url', default='http://127.0.0.1:8765/')
    args = parser.parse_args()
    repo = canonical(args.repo, directory=True)
    bridge = Bridge(repo)
    try:
        identity = bridge.verified()
        if args.command in ('extensions', 'install-extensions'):
            items = packages(repo)
            if args.command == 'install-extensions':
                result=[]
                for item in items:
                    bridge.verified()
                    row=bridge.client.script(INSTALL,[item['package'],item['id']],asynchronous=True)
                    if not row.get('active') or row.get('version') != item['version']:
                        raise RuntimeError('Fresh extension install failed: '+item['id'])
                    result.append(row)
            else:
                result=bridge.client.script(EXTENSIONS,[[item['id'] for item in items]],asynchronous=True)
                if not isinstance(result,list) or any(not row.get('active') for row in result):
                    raise RuntimeError('An extension is missing or inactive')
        else:
            parsed=urlsplit(args.url)
            if parsed.scheme!='http' or parsed.hostname!='127.0.0.1' or parsed.username or parsed.password or parsed.path!='/':
                raise ValueError('Use the synthetic loopback fixture root URL')
            if args.command=='seed':
                bridge.client.script('Services.prefs.setIntPref("browser.startup.page",3); return true;')
                bridge.tab('open',url=args.url+'seed')
            else:
                state=bridge.state()['browser']
                tabs=[t for t in state['tabs'] if t['url']==args.url]
                if not tabs:
                    raise RuntimeError('Seed tab did not survive browser restart')
                snap=bridge.inspect('tab')
                tab=next(row for row in snap['elements'] if row.get('tag')=='tab' and
                         ((tabs[0]['id'] and row['id']==tabs[0]['id']) or tabs[0]['label'] in row['label']))
                bridge.tab('select',snapshot_id=snap['snapshot_id'],handle=tab['handle'])
            selected_content(bridge)
            for _ in range(40):
                result=bridge.client.script(PAGE_STATE)
                if result['ready']=='complete' and result['title']=='Zen compatibility probe':
                    break
                time.sleep(.25)
            if not result.get('cookie_ok'):
                raise RuntimeError('Synthetic persistent cookie is missing')
            if args.command=='seed':
                bridge.client.script('localStorage.setItem("zen-probe-counter","41"); return true;')
                result=bridge.client.script(PAGE_STATE)
            elif result.get('counter')!='41':
                raise RuntimeError('Synthetic storage did not survive browser restart')
        print(json.dumps({'source_sha':identity['source_sha'],'profile':identity['profile'],
                          'command':args.command,'observation':result},indent=2))
        print('PROBE VERIFIED')
    finally:
        bridge.close()


if __name__=='__main__':
    main()
