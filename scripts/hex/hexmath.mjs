/**
 * Гекс-сетка без Foundry: для тестов и стенда. В игре вместо неё работает canvas.grid,
 * адаптер в grid.mjs отдаёт тот же набор функций.
 *
 * Сетка «острым верхом», нечётные ряды сдвинуты вправо (как HEXODDR в Foundry).
 * Ячейка задаётся [i, j]: i — ряд, j — столбец. size — высота гекса от вершины до вершины.
 */
export default class HexMath {
  constructor({ size = 100, rows = 20, cols = 30, x0 = 0, y0 = 0 } = {}) {
    this.size = size;
    this.rows = rows;
    this.cols = cols;
    this.x0 = x0;
    this.y0 = y0;
    this.w = Math.sqrt(3) / 2 * size;      // ширина гекса
    this.h = size;                          // высота
  }

  /** Радиус описанной окружности. */
  get radius() { return this.size / 2; }

  center([i, j]) {
    return {
      x: this.x0 + (this.w / 2) + (j * this.w) + ((i & 1) ? this.w / 2 : 0),
      y: this.y0 + (this.h / 2) + (i * this.h * 0.75)
    };
  }

  vertices(cell) {
    const { x, y } = this.center(cell);
    const r = this.size / 2;
    const out = [];
    for ( let k = 0; k < 6; k++ ) {
      const a = (Math.PI / 180) * ((60 * k) - 90);
      out.push({ x: x + (r * Math.cos(a)), y: y + (r * Math.sin(a)) });
    }
    return out;
  }

  /** Ячейка под точкой: перевод в кубические координаты и округление. */
  cellAt({ x, y }) {
    const px = x - this.x0 - (this.w / 2);
    const py = y - this.y0 - (this.h / 2);
    const r = this.size / 2;
    const q = ((Math.sqrt(3) / 3 * px) - (py / 3)) / r;
    const rr = (2 / 3 * py) / r;
    let cx = q, cz = rr, cy = -cx - cz;
    let rx = Math.round(cx), ry = Math.round(cy), rz = Math.round(cz);
    const dx = Math.abs(rx - cx), dy = Math.abs(ry - cy), dz = Math.abs(rz - cz);
    if ( dx > dy && dx > dz ) rx = -ry - rz;
    else if ( dy > dz ) ry = -rx - rz;
    else rz = -rx - ry;
    const i = rz;
    const j = rx + ((rz - (rz & 1)) / 2);
    return [i, j];
  }

  neighbors([i, j]) {
    const odd = i & 1;
    const d = odd
      ? [[0, 1], [0, -1], [-1, 0], [-1, 1], [1, 0], [1, 1]]
      : [[0, 1], [0, -1], [-1, -1], [-1, 0], [1, -1], [1, 0]];
    return d.map(([di, dj]) => [i + di, j + dj]);
  }

  /** Все ячейки поля. */
  allCells() {
    const out = [];
    for ( let i = 0; i < this.rows; i++ ) for ( let j = 0; j < this.cols; j++ ) out.push([i, j]);
    return out;
  }

  inBounds([i, j]) {
    return i >= 0 && j >= 0 && i < this.rows && j < this.cols;
  }

  get width() { return (this.cols * this.w) + (this.w / 2); }
  get height() { return (this.rows - 1) * this.h * 0.75 + this.h; }
}
