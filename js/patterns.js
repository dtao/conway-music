// Riff presets: classic Game of Life patterns as starting compositions.
// "O" is a live cell, "." is dead. Each preset is stamped centered on the
// board; the grid wraps, so travelers loop forever.

export const PRESETS = [
  {
    name: "Glider — wandering melody",
    cells: [
      ".O.",
      "..O",
      "OOO",
    ],
  },
  {
    name: "Lightweight spaceship — cruising riff",
    cells: [
      ".O..O",
      "O....",
      "O...O",
      "OOOO.",
    ],
  },
  {
    name: "Blinker row — metronome",
    cells: [
      "OOO.....OOO.....OOO",
    ],
  },
  {
    name: "Toad & beacon — syncopation",
    cells: [
      ".OOO......",
      "OOO.......",
      "..........",
      "......OO..",
      "......OO..",
      "........OO",
      "........OO",
    ],
  },
  {
    name: "Pulsar — big chord cycle",
    cells: [
      "..OOO...OOO..",
      ".............",
      "O....O.O....O",
      "O....O.O....O",
      "O....O.O....O",
      "..OOO...OOO..",
      ".............",
      "..OOO...OOO..",
      "O....O.O....O",
      "O....O.O....O",
      "O....O.O....O",
      ".............",
      "..OOO...OOO..",
    ],
  },
  {
    name: "Pentadecathlon — 15-beat loop",
    cells: [
      "..O....O..",
      "OO.OOOO.OO",
      "..O....O..",
    ],
  },
  {
    name: "Gosper glider gun — endless arpeggios",
    cells: [
      "........................O...........",
      "......................O.O...........",
      "............OO......OO............OO",
      "...........O...O....OO............OO",
      "OO........O.....O...OO..............",
      "OO........O...O.OO....O.O...........",
      "..........O.....O.......O...........",
      "...........O...O....................",
      "............OO......................",
    ],
  },
  {
    name: "R-pentomino — long improvisation",
    cells: [
      ".OO",
      "OO.",
      ".O.",
    ],
  },
  {
    name: "Acorn — slow-burn jam",
    cells: [
      ".O.....",
      "...O...",
      "OO..OOO",
    ],
  },
  {
    name: "Diehard — fade to silence",
    cells: [
      "......O.",
      "OO......",
      ".O...OOO",
    ],
  },
];

/**
 * Stamp a preset centered onto a LifeGrid (with toroidal wrap, so presets
 * larger than the grid still land somewhere sensible).
 */
export function stampPreset(grid, preset) {
  const patRows = preset.cells.length;
  const patCols = Math.max(...preset.cells.map((row) => row.length));
  const dc = Math.floor((grid.cols - patCols) / 2);
  const dr = Math.floor((grid.rows - patRows) / 2);
  for (let row = 0; row < patRows; row++) {
    for (let col = 0; col < preset.cells[row].length; col++) {
      if (preset.cells[row][col] !== "O") continue;
      const targetCol = ((col + dc) % grid.cols + grid.cols) % grid.cols;
      const targetRow = ((row + dr) % grid.rows + grid.rows) % grid.rows;
      grid.cells[grid.index(targetCol, targetRow)] = 1;
    }
  }
}
