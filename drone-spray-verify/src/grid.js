// 米制栅格：把连续的地块/航迹问题转成离散单元做覆盖率统计与连通域聚类

export class Grid {
  /**
   * @param {{minX:number,minY:number,maxX:number,maxY:number,cell:number}} opts
   * cell 为栅格边长（米）
   */
  constructor({ minX, minY, maxX, maxY, cell }) {
    this.minX = minX;
    this.minY = minY;
    this.cell = cell;
    this.nx = Math.max(1, Math.ceil((maxX - minX) / cell));
    this.ny = Math.max(1, Math.ceil((maxY - minY) / cell));
    this.size = this.nx * this.ny;
  }

  static fromBbox([minX, minY, maxX, maxY], pad, cell) {
    return new Grid({
      minX: minX - pad,
      minY: minY - pad,
      maxX: maxX + pad,
      maxY: maxY + pad,
      cell,
    });
  }

  inBounds(ix, iy) {
    return ix >= 0 && iy >= 0 && ix < this.nx && iy < this.ny;
  }

  index(ix, iy) {
    return iy * this.nx + ix;
  }

  coordOf(index) {
    return [index % this.nx, Math.floor(index / this.nx)];
  }

  /** 米制坐标 -> 栅格坐标 */
  cellAt(x, y) {
    return [
      Math.floor((x - this.minX) / this.cell),
      Math.floor((y - this.minY) / this.cell),
    ];
  }

  center(index) {
    const [ix, iy] = this.coordOf(index);
    return [
      this.minX + (ix + 0.5) * this.cell,
      this.minY + (iy + 0.5) * this.cell,
    ];
  }

  /**
   * 在 (x,y) 周围半径 r（米）的圆盘上迭代栅格 index。
   * exact=true 时按栅格中心到点的真实欧氏距离判定（避免整数格取整导致圆盘偏大）。
   */
  *diskIndices(x, y, radius, { exact = false } = {}) {
    const [cx, cy] = this.cellAt(x, y);
    const k = Math.ceil(radius / this.cell);
    for (let dy = -k; dy <= k; dy++) {
      for (let dx = -k; dx <= k; dx++) {
        const ix = cx + dx, iy = cy + dy;
        if (!this.inBounds(ix, iy)) continue;
        if (exact) {
          const [ccx, ccy] = this.center(this.index(ix, iy));
          if (Math.hypot(ccx - x, ccy - y) > radius + 1e-9) continue;
        } else {
          const cells = dx * this.cell, cellY = dy * this.cell;
          if (Math.hypot(cells, cellY) > radius + this.cell) continue;
        }
        yield this.index(ix, iy);
      }
    }
  }
}
