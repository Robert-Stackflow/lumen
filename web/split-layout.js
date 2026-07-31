(function exposeSplitLayout(root) {
  class SplitLayout {
    constructor() {
      this.primaryId = null;
      this.secondaryId = null;
      this.direction = 'vertical';
      this.ratio = 0.5;
    }

    get active() {
      return Boolean(this.primaryId && this.secondaryId);
    }

    contains(id) {
      return this.active && (id === this.primaryId || id === this.secondaryId);
    }

    open(primaryId, secondaryId, direction = 'vertical') {
      if (!primaryId || !secondaryId || primaryId === secondaryId) return false;
      this.primaryId = primaryId;
      this.secondaryId = secondaryId;
      this.direction = direction === 'horizontal' ? 'horizontal' : 'vertical';
      return true;
    }

    close() {
      this.primaryId = null;
      this.secondaryId = null;
    }

    resize(ratio) {
      this.ratio = Math.min(0.75, Math.max(0.25, Number(ratio) || 0.5));
      return this.ratio;
    }

    restore(value, validIds) {
      if (!value || !validIds.has(value.primaryId) || !validIds.has(value.secondaryId)) return false;
      if (!this.open(value.primaryId, value.secondaryId, value.direction)) return false;
      this.resize(value.ratio);
      return true;
    }

    serialize() {
      return this.active ? {
        primaryId: this.primaryId,
        secondaryId: this.secondaryId,
        direction: this.direction,
        ratio: this.ratio,
      } : null;
    }
  }

  root.LumenSplitLayout = SplitLayout;
}(globalThis));
