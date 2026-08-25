import {
  FolderNode, ancestorPaths, buildFolderTree, findNode, flattenNodes, folderRows, splitRoot,
} from './folder-tree.util';

// The picker rebuilds the folder hierarchy from flat paths, so this util decides
// what the tree in the portal looks like — including for Windows paths, which is
// the only notation most Huddle users will ever index.
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

describe('buildFolderTree', () => {
  it('zet vlakke paden om in een boom en markeert wat geïndexeerd is', () => {
    const tree = buildFolderTree(['T:/projects/huddle', 'T:/projects/huddle/gateway']);
    expect(tree.length).toBe(1);
    expect(tree[0].name).toBe('T:');
    // 'T:/projects' staat niet in de index maar bestaat aantoonbaar wel.
    const projects = tree[0].children[0];
    expect([projects.name, projects.indexed]).toEqual(['projects', false]);
    expect(projects.children[0].indexed).toBe(true);
    expect(projects.children[0].children[0].path).toBe('T:/projects/huddle/gateway');
  });

  it('voegt beide Windows-schrijfwijzen samen tot één tak', () => {
    const tree = buildFolderTree(['T:/projects/app', 't:\\projects\\app\\src']);
    expect(tree.length).toBe(1);
    expect(tree[0].children[0].children.length).toBe(1);
  });

  it('sorteert hoofdletterongevoelig', () => {
    const tree = buildFolderTree(['C:/a/Zebra', 'C:/a/apple', 'C:/a/Beta']);
    expect(tree[0].children[0].children.map((c) => c.name)).toEqual(['apple', 'Beta', 'Zebra']);
  });

  it('houdt meerdere drives uit elkaar', () => {
    expect(buildFolderTree(['C:/a', 'D:/b']).map((r) => r.name)).toEqual(['C:', 'D:']);
  });
});

describe('folderRows', () => {
  const tree = buildFolderTree(['T:/projects/huddle/gateway', 'T:/projects/other']);

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
});

describe('ancestorPaths', () => {
  it('geeft de takken die open moeten om een waarde te tonen', () => {
    expect(ancestorPaths('T:/projects/huddle/gateway')).toEqual(['T:/', 'T:/projects', 'T:/projects/huddle']);
  });

  it('heeft voor een root niets open te klappen', () => {
    expect(ancestorPaths('T:/')).toEqual(['T:/']);
  });
});

// De diepte van deze boom is de segmentdiepte van een geïndexeerd hostpad, en
// niets aan de schrijfkant begrenst die. Een recursieve wandeling liet daarmee
// een pad bepalen hoe diep onze call stack gaat (CWE-674). Deze boom wordt
// rechtstreeks opgebouwd i.p.v. via buildFolderTree: die bewaart per knoop het
// volledige pad, en dat is op deze diepte kwadratisch in geheugen.
describe('diepe bomen', () => {
  const DEEP = 50_000;

  function deepTree(depth: number): FolderNode[] {
    const root: FolderNode = { path: 'T:/', name: 'T:', indexed: false, children: [] };
    let node = root;
    for (let i = 0; i < depth; i++) {
      const child: FolderNode = { path: `n${i}`, name: `n${i}`, indexed: i === depth - 1, children: [] };
      node.children.push(child);
      node = child;
    }
    return [root];
  }

  it('maakt 50.000 niveaus plat en vindt de diepste knoop', () => {
    const tree = deepTree(DEEP);
    expect(flattenNodes(tree).length).toBe(DEEP + 1); // + de root
    expect(findNode(tree, `n${DEEP - 1}`)?.indexed).toBe(true);
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
    // hit bevat opent zichzelf. Ondieper gehouden omdat dit filter per knoop de
    // subboom naloopt en dus kwadratisch is in tijd.
    const tree = deepTree(5_000);
    const rows = folderRows(tree, new Set<string>(), 'n4999');
    expect(rows.length).toBe(5_001);
  });
});
