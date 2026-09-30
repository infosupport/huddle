import {
  FolderNode, ancestorPaths, findNode, flattenNodes, folderRows, makeNode, setChildren, splitRoot,
} from './folder-tree.util';

// The picker grows this tree one folder at a time from what Huddle Node lists on
// the host, so this util decides what the portal draws — including for Windows
// paths, which is the only notation most Huddle users will ever type.
describe('splitRoot', () => {
  it('neemt de driveletter als root', () => {
    expect(splitRoot('T:/projects/huddle')).toEqual({ root: 'T:/', rest: ['projects', 'huddle'] });
  });

  it('accepteert backslashes en kleine letters', () => {
    expect(splitRoot('t:\\projects\\huddle')).toEqual({ root: 'T:/', rest: ['projects', 'huddle'] });
  });

  it('houdt een UNC-share bij elkaar als root', () => {
    expect(splitRoot('//server/share/team/app')).toEqual({ root: '//server/share', rest: ['team', 'app'] });
  });

  it('gebruikt / als root op Linux-paden', () => {
    expect(splitRoot('/home/vscode/app')).toEqual({ root: '/', rest: ['home', 'vscode', 'app'] });
  });
});

describe('setChildren', () => {
  it('maakt van een listing kinderen en markeert de map als geladen', () => {
    const node = makeNode('T:/projects', 'projects');
    expect(node.loaded).toBe(false);
    setChildren(node, [{ path: 'T:/projects/api', name: 'api' }]);
    expect(node.loaded).toBe(true);
    expect(node.children.map((c) => c.name)).toEqual(['api']);
  });

  it('houdt een al geladen tak intact als de map opnieuw gelezen wordt', () => {
    const node = makeNode('T:/projects', 'projects');
    setChildren(node, [{ path: 'T:/projects/api', name: 'api' }]);
    setChildren(node.children[0], [{ path: 'T:/projects/api/src', name: 'src' }]);

    setChildren(node, [{ path: 'T:/projects/api', name: 'api' }, { path: 'T:/projects/web', name: 'web' }]);
    // De tak waar je vandaan komt mag niet dichtklappen omdat de ouder ververst is.
    expect(node.children[0].children.map((c) => c.name)).toEqual(['src']);
    expect(node.children.map((c) => c.name)).toEqual(['api', 'web']);
  });

  it('laat een map die van de host verdwenen is ook hier verdwijnen', () => {
    const node = makeNode('T:/projects', 'projects');
    setChildren(node, [{ path: 'T:/projects/api', name: 'api' }, { path: 'T:/projects/old', name: 'old' }]);
    setChildren(node, [{ path: 'T:/projects/api', name: 'api' }]);
    expect(node.children.map((c) => c.name)).toEqual(['api']);
  });

  it('leest een lege listing als "niets in deze map", niet als "nog niet gekeken"', () => {
    const node = makeNode('T:/leeg', 'leeg');
    setChildren(node, []);
    expect([node.loaded, node.children.length]).toEqual([true, 0]);
  });
});

/**
 * Een volledig geladen boom uit vlakke paden — wat het scherm stap voor stap via
 * de API opbouwt, hier in één keer, zodat deze tests over rijen gaan en niet over
 * laadvolgorde.
 */
function loadedTree(paths: string[]): FolderNode[] {
  const roots: FolderNode[] = [];
  const byPath = new Map<string, FolderNode>();
  for (const raw of paths) {
    const { root, rest } = splitRoot(raw);
    let node = byPath.get(root.toLowerCase());
    if (!node) {
      node = makeNode(root, root === '/' ? '/' : root.replace(/\/$/, ''));
      node.loaded = true;
      byPath.set(root.toLowerCase(), node);
      roots.push(node);
    }
    let current = root;
    for (const segment of rest) {
      current = current.endsWith('/') ? `${current}${segment}` : `${current}/${segment}`;
      let child = byPath.get(current.toLowerCase());
      if (!child) {
        child = makeNode(current, segment);
        child.loaded = true;
        byPath.set(current.toLowerCase(), child);
        node.children.push(child);
      }
      node = child;
    }
  }
  return roots;
}

describe('folderRows', () => {
  const tree = loadedTree(['T:/projects/huddle/gateway', 'T:/projects/other']);

  it('toont alleen wat opengeklapt is', () => {
    expect(folderRows(tree, new Set()).map((r) => r.node.name)).toEqual(['T:']);
    expect(folderRows(tree, new Set(['t:/'])).map((r) => r.node.name)).toEqual(['T:', 'projects']);
  });

  it('klapt bij filteren de tak met de treffer zelf open', () => {
    const names = folderRows(tree, new Set(), 'gateway').map((r) => r.node.name);
    expect(names).toEqual(['T:', 'projects', 'huddle', 'gateway']);
  });

  it('laat takken zonder treffer weg', () => {
    const paths = folderRows(tree, new Set(), 'other').map((r) => r.node.path);
    expect(paths).toEqual(['T:/', 'T:/projects', 'T:/projects/other']);
  });

  it('geeft de diepte mee voor de inspringing', () => {
    expect(folderRows(tree, new Set(), 'gateway').map((r) => r.depth)).toEqual([0, 1, 2, 3]);
  });

  // Een nog niet gelezen map heeft geen kinderen, maar heeft ze misschien wel:
  // zonder pijltje is er niets om op te klikken en blijft de host onbereikbaar.
  it('geeft een ongelezen map een pijltje en een lege gelezen map niet', () => {
    const unread = makeNode('T:/onbekend', 'onbekend');
    const empty = makeNode('T:/leeg', 'leeg');
    setChildren(empty, []);
    const rows = folderRows([unread, empty], new Set());
    expect(rows.map((r) => r.canExpand)).toEqual([true, false]);
  });
});

describe('ancestorPaths', () => {
  it('geeft de takken die open moeten om een waarde te tonen', () => {
    expect(ancestorPaths('T:/projects/huddle/gateway')).toEqual(['T:/', 'T:/projects', 'T:/projects/huddle']);
  });

  it('heeft voor een root niets open te klappen', () => {
    expect(ancestorPaths('T:/')).toEqual(['T:/']);
  });
});

// De diepte van deze boom is hoe diep de operator doorgeklikt heeft, en niets
// begrenst dat. Een recursieve wandeling liet daarmee een mappenstructuur
// bepalen hoe diep onze call stack gaat (CWE-674).
describe('diepe bomen', () => {
  const DEEP = 50_000;

  function deepTree(depth: number): FolderNode[] {
    const root: FolderNode = { path: 'T:/', name: 'T:', loaded: true, children: [] };
    let node = root;
    for (let i = 0; i < depth; i++) {
      const child: FolderNode = { path: `n${i}`, name: `n${i}`, loaded: true, children: [] };
      node.children.push(child);
      node = child;
    }
    return [root];
  }

  it('maakt 50.000 niveaus plat en vindt de diepste knoop', () => {
    const tree = deepTree(DEEP);
    expect(flattenNodes(tree).length).toBe(DEEP + 1); // + de root
    expect(findNode(tree, `n${DEEP - 1}`)?.name).toBe(`n${DEEP - 1}`);
  });

  it('maakt rijen van 50.000 open niveaus', () => {
    const tree = deepTree(DEEP);
    const expanded = new Set(flattenNodes(tree).map((n) => n.path.toLowerCase()));
    const rows = folderRows(tree, expanded);
    expect(rows.length).toBe(DEEP + 1);
    expect(rows[rows.length - 1].depth).toBe(DEEP);
  });

  it('filtert een diepe boom zonder de stack op te blazen', () => {
    // Zonder open takken raakt het filter toch de volle diepte: een tak die een
    // hit bevat opent zichzelf. Op dezelfde diepte als hierboven, want de
    // subboom-treffers worden in één pass bepaald; een versie die per knoop de
    // subboom naloopt is kwadratisch en haalt dit niet binnen de timeout.
    const tree = deepTree(DEEP);
    const rows = folderRows(tree, new Set<string>(), `n${DEEP - 1}`);
    expect(rows.length).toBe(DEEP + 1);
  });
});
