#!/usr/bin/env node

const fs = require('fs');
const { program } = require('commander');
const dagre = require('dagre');
const { create } = require('xmlbuilder2');

// --- 1. CLI Setup ---
program
  .version('1.2.0')
  .description('Convert Mermaid flowcharts/sitemaps to Draw.io XML')
  .argument('<inputFile>', 'Path to the mermaid file (.mmd)')
  .option('-o, --output <path>', 'Output file path', 'output.drawio')
  .action((inputFile, options) => {
    convert(inputFile, options.output);
  });

program.parse(process.argv);

// --- 2. Main Logic ---
function convert(inputFile, outputFile) {
  try {
    const mermaidContent = fs.readFileSync(inputFile, 'utf8');
    console.log(`📖 Reading ${inputFile}...`);

    // 1. Parse
    const graphData = parseMermaid(mermaidContent);
    
    if (graphData.nodes.length === 0) {
      console.error('❌ No nodes found. Check your file syntax.');
      return;
    }

    // 2. Fix Orphans (The fix you asked for)
    // If we have multiple "roots", connect them to the main Home node
    linkOrphansToRoot(graphData);

    // 3. Calculate Levels (for coloring)
    assignNodeLevels(graphData);

    // 4. Layout
    console.log('📐 Calculating layout...');
    const layout = calculateLayout(graphData);

    // 5. Generate XML
    console.log('🎨 Applying sitemap colors and building XML...');
    const xml = generateDrawioXml(layout);

    fs.writeFileSync(outputFile, xml);
    console.log(`✅ Success! Created ${outputFile}`);
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
  }
}

// --- 3. The Smart Parser ---
function parseMermaid(text) {
  const lines = text.split('\n');
  const nodes = new Map();
  const edges = [];

  // Regex to capture "A[Label]" or just "A"
  const nodePattern = /([a-zA-Z0-9_]+)(?:\[(.+?)\]|\((.+?)\))?/g; 

  lines.forEach(line => {
    const cleanLine = line.trim();
    if (!cleanLine || cleanLine.startsWith('graph') || cleanLine.startsWith('flowchart')) return;

    // A. Parse Nodes first
    // We use matchAll to find every node definition on the line
    const matches = [...cleanLine.matchAll(nodePattern)];
    matches.forEach(match => {
      const id = match[1];
      const label = match[2] || match[3] || id;

      if (!nodes.has(id)) {
        nodes.set(id, { id, label: label === id ? id : label });
      } else if (label !== id) {
        // Update label if we found a descriptive one
        nodes.get(id).label = label;
      }
    });

    // B. Parse Edges (Supports chained: A --> B --> C)
    // We split by the arrow syntax to get parts
    const parts = cleanLine.split(/\s*--?>?\s*/);
    
    if (parts.length > 1) {
      for (let i = 0; i < parts.length - 1; i++) {
        // Extract ID from the part (remove brackets if present to get raw ID)
        const sourceRaw = parts[i].match(/([a-zA-Z0-9_]+)/);
        const targetRaw = parts[i+1].match(/([a-zA-Z0-9_]+)/);

        if (sourceRaw && targetRaw) {
          edges.push({ source: sourceRaw[1], target: targetRaw[1] });
        }
      }
    }
  });

  return { nodes: Array.from(nodes.values()), edges };
}

// --- 4. The Fix: Link Orphans to Root ---
function linkOrphansToRoot(data) {
  const incoming = {};
  data.nodes.forEach(n => incoming[n.id] = 0);
  data.edges.forEach(e => {
    if (incoming[e.target] !== undefined) incoming[e.target]++;
  });

  // Find all nodes that have NO incoming edges (Roots)
  const roots = data.nodes.filter(n => incoming[n.id] === 0);

  if (roots.length > 1) {
    console.log(`ℹ️ Found ${roots.length} disconnected roots. Auto-linking them...`);
    
    // Try to find a "Home" node to be the main parent, otherwise pick the first one
    const mainRoot = roots.find(r => r.label.toLowerCase().includes('home')) || roots[0];

    roots.forEach(r => {
      if (r.id !== mainRoot.id) {
        console.log(`   🔗 Connecting orphan "${r.label}" to "${mainRoot.label}"`);
        data.edges.push({ source: mainRoot.id, target: r.id });
      }
    });
  }
}

// --- 5. Level Calculator (BFS) ---
function assignNodeLevels(data) {
    data.nodes.forEach(n => n.level = -1);

    const adj = {};
    data.nodes.forEach(n => adj[n.id] = []);
    data.edges.forEach(e => adj[e.source].push(e.target));

    // Find the single root (now guaranteed by the fix above)
    // Recalculate incoming just to be safe
    const incoming = {};
    data.nodes.forEach(n => incoming[n.id] = 0);
    data.edges.forEach(e => incoming[e.target]++);
    
    const root = data.nodes.find(n => incoming[n.id] === 0) || data.nodes[0];
    
    if(root) {
        root.level = 0;
        const queue = [root];
        while(queue.length > 0) {
            const current = queue.shift();
            const neighbors = adj[current.id] || [];
            neighbors.forEach(nid => {
                const node = data.nodes.find(n => n.id === nid);
                if (node && node.level === -1) {
                    node.level = current.level + 1;
                    queue.push(node);
                }
            });
        }
    }
}

// --- 6. Layout Engine ---
function calculateLayout(data) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 80 });
  g.setDefaultEdgeLabel(() => ({}));

  data.nodes.forEach(node => {
    g.setNode(node.id, { label: node.label, width: 140, height: 70, level: node.level });
  });

  data.edges.forEach(edge => {
    g.setEdge(edge.source, edge.target);
  });

  dagre.layout(g);

  return {
    nodes: g.nodes().map(v => {
      const node = g.node(v);
      return { 
          id: v, 
          label: node.label, 
          x: node.x, 
          y: node.y, 
          width: node.width, 
          height: node.height,
          level: node.level
      };
    }),
    edges: g.edges().map(e => ({ source: e.v, target: e.w }))
  };
}

// --- 7. XML Generator ---
function generateDrawioXml(layout) {
  const colors = [
      { fill: '#dae8fc', stroke: '#6c8ebf' }, // L0: Blue
      { fill: '#d5e8d4', stroke: '#82b366' }, // L1: Green
      { fill: '#ffe6cc', stroke: '#d79b00' }, // L2: Orange
      { fill: '#e1d5e7', stroke: '#9673a6' }, // L3: Purple
  ];
  const defaultColor = { fill: '#f5f5f5', stroke: '#666666' }; 

  const root = create({ version: '1.0', encoding: 'UTF-8' })
    .ele('mxfile', { host: 'Electron', type: 'device' })
    .ele('diagram', { name: 'Sitemap', id: 'diagram_1' })
    .ele('mxGraphModel', { dx: '1000', dy: '1000', grid: '1', gridSize: '10', guides: '1', tooltips: '1', connect: '1', arrows: '1', fold: '1', page: '1', pageScale: '1', pageWidth: '827', pageHeight: '1169', math: '0', shadow: '0' })
    .ele('root');

  root.ele('mxCell', { id: '0' });
  root.ele('mxCell', { id: '1', parent: '0' });

  // Nodes
  layout.nodes.forEach(node => {
    const styleObj = (node.level >= 0 && node.level < colors.length) ? colors[node.level] : defaultColor;
    const style = `rounded=1;whiteSpace=wrap;html=1;shadow=1;fillColor=${styleObj.fill};strokeColor=${styleObj.stroke};fontStyle=1;fontSize=14;`;

    const mxCell = root.ele('mxCell', {
      id: node.id,
      value: node.label,
      style: style,
      parent: '1',
      vertex: '1'
    });
    
    mxCell.ele('mxGeometry', {
      x: node.x - (node.width / 2),
      y: node.y - (node.height / 2),
      width: node.width,
      height: node.height,
      as: 'geometry'
    });
  });

  // Edges
  layout.edges.forEach((edge, index) => {
    const edgeStyle = 'edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=1;entryX=0.5;entryY=0;entryDx=0;entryDy=0;exitX=0.5;exitY=1;exitDx=0;exitDy=0;strokeWidth=2;';
    
    const mxCell = root.ele('mxCell', {
      id: `edge_${index}`,
      style: edgeStyle,
      edge: '1',
      parent: '1',
      source: edge.source,
      target: edge.target
    });

    const geometry = mxCell.ele('mxGeometry', { relative: '1', as: 'geometry' });
    geometry.ele('mxPoint', { x: 0, y: 0, as: 'sourcePoint'}); 
    geometry.ele('mxPoint', { x: 0, y: 0, as: 'targetPoint'}); 
  });

  return root.end({ prettyPrint: true });
}