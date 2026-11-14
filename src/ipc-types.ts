/**
 * IPC types, kept apart from the parsing and fetching code so that a UI can depend on the
 * shape of the index without importing anything that touches the network or a credential.
 */

/** One monthly observation of the IPC index. */
export type IpcPoint = {
  /** "YYYY-MM" - the month the index belongs to, never the month it was published. */
  month: string;
  /** Index level. Base 2023 = 100 on the chained series this library reads. */
  index: number;
};

/**
 * The whole monthly index, as resolved on the server.
 *
 * The series is monthly and short - roughly two hundred points - so the honest and fast
 * design is to ship all of it once and let the browser compute any period the visitor
 * asks for. The alternative, a request per date range, would put a Banco Central round
 * trip behind every keystroke for no gain in accuracy.
 */
export type IpcSeries = {
  /** Ascending by month. Never empty: an empty resolution is represented by `null`. */
  points: IpcPoint[];
  /** Attribution, e.g. "Banco Central de Chile". */
  source: string;
  /** The exact BDE series identifier the values came from. Part of the provenance. */
  seriesId: string;
  /** Series description as the service itself stated it, when it states one. */
  description: string | null;
};

/**
 * The result of adjusting an amount between two months.
 *
 * `fromIndex` and `toIndex` are carried so the interface can show which two published
 * figures produced the answer. A reajuste the tenant cannot check is a reajuste the
 * tenant will argue about.
 */
export type RentAdjustment = {
  from: IpcPoint;
  to: IpcPoint;
  /**
   * The variation implied by dividing the two PUBLISHED index levels, as a ratio:
   * 0.041322 is 4,1322%. Full precision, and exactly what the audit line shows, because
   * this is the number a reader can reproduce from the two figures on screen.
   *
   * NOT what the money is adjusted by - see `officialRatio`.
   */
  accumulated: number;
  /**
   * The OFFICIAL variation for the period: `accumulated` expressed to one decimal place,
   * as a ratio. 0.041 is 4,1%.
   *
   * This is the figure the adjusted amount is computed from, because it is the figure INE
   * itself publishes and applies. INE states the rule on its own calculator: the index is
   * carried internally to twelve decimals, but "la variación presentada es a un decimal,
   * ya que la variación oficial del índice también es a un decimal" - and its Calculadora
   * IPC then adjusts money by that one-decimal variation.
   *
   * Adopting it is what makes this library agree with the official calculator to the peso
   * rather than to within a couple of hundred. See `test/ipc.test.ts` for the five
   * validated cases.
   */
  officialRatio: number;
  /** The adjusted amount, unrounded. Derived from `officialRatio`, never from `accumulated`. */
  adjustedClp: number;
  /** Adjusted less current. Negative when the IPC fell over the period. */
  differenceClp: number;
};
