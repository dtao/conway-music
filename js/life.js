// Conway's Game of Life on a toroidal grid (edges wrap), stored as flat
// Uint8Arrays indexed by row * cols + col.

export class LifeGrid {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.cells = new Uint8Array(cols * rows);
    this._next = new Uint8Array(cols * rows);
    this.generation = 0;
  }

  index(col, row) {
    return row * this.cols + col;
  }

  get(col, row) {
    return this.cells[this.index(col, row)];
  }

  set(col, row, alive) {
    this.cells[this.index(col, row)] = alive ? 1 : 0;
  }

  toggle(col, row) {
    const i = this.index(col, row);
    this.cells[i] = this.cells[i] ? 0 : 1;
    return this.cells[i];
  }

  clear() {
    this.cells.fill(0);
    this.generation = 0;
  }

  randomize(density = 0.25, rng = Math.random) {
    for (let i = 0; i < this.cells.length; i++) {
      this.cells[i] = rng() < density ? 1 : 0;
    }
    this.generation = 0;
  }

  get population() {
    let count = 0;
    for (let i = 0; i < this.cells.length; i++) count += this.cells[i];
    return count;
  }

  /**
   * Advance one generation. Returns { births, deaths } as arrays of cell
   * indices that changed state, so callers can start/stop sounds.
   */
  step() {
    const { cols, rows, cells, _next: next } = this;
    const births = [];
    const deaths = [];

    for (let row = 0; row < rows; row++) {
      const up = (row === 0 ? rows - 1 : row - 1) * cols;
      const mid = row * cols;
      const down = (row === rows - 1 ? 0 : row + 1) * cols;

      for (let col = 0; col < cols; col++) {
        const left = col === 0 ? cols - 1 : col - 1;
        const right = col === cols - 1 ? 0 : col + 1;

        const neighbors =
          cells[up + left] + cells[up + col] + cells[up + right] +
          cells[mid + left] + cells[mid + right] +
          cells[down + left] + cells[down + col] + cells[down + right];

        const i = mid + col;
        const alive = cells[i] === 1;
        const survives = alive ? neighbors === 2 || neighbors === 3 : neighbors === 3;
        next[i] = survives ? 1 : 0;

        if (!alive && survives) births.push(i);
        else if (alive && !survives) deaths.push(i);
      }
    }

    this.cells.set(next);
    this.generation++;
    return { births, deaths };
  }
}
