// source: models/metrics.ts
/// <reference path="proto.ts" />
/// <reference path="../typings/mithriljs/mithril.d.ts" />
/// <reference path="../util/chainprop.ts" />
/// <reference path="../util/convert.ts" />
/// <reference path="../util/http.ts" />
/// <reference path="../util/querycache.ts" />
// Author: Matt Tracy (matt@cockroachlabs.com)

/**
 * Models contains data models pulled from cockroach.
 */
module Models {
    /**
     * Metrics package represents the internal performance metrics collected by
     * cockroach.
     */
    export module Metrics {
        import promise = _mithril.MithrilPromise;

        /**
         * QueryInfo is an interface that is implemented by both Proto.QueryResult and
         * Proto.QueryRequest. A QueryInfo object references a unique dataset
         * that can be returned from the server.
         */
        interface QueryInfo {
            name:string;
            aggregator:Proto.QueryAggregator;
        }

        /**
         * QueryInfoKey returns a string key that uniquely identifies the
         * server-side dataset referenced by the QueryInfo.
         */
        export function QueryInfoKey(qi:QueryInfo):string {
            return Proto.QueryAggregator[qi.aggregator] + ":" + qi.name; 
        }

        /**
         * QueryInfoSet is a generic set structure which contains at most one
         * QueryInfo object for each possible key. They key for a QueryInfo
         * object should be generated with the QueryInfoKey() method.
         */
        class QueryInfoSet<T extends QueryInfo> {
            private _set:{[key:string]:T} = {};
            
            /**
             * add adds an object of type T to this set. The supplied T is
             * uniquely identified by the output of QueryKey(). If the set
             * already contains an entry with the same QueryKey, it is
             * overwritten.
             */
            add(qi:T) {
                var key = QueryInfoKey(qi);
                this._set[key] = qi;
            }

            /**
             * get returns the object in the set which has the given key. 
             */
            get(key:string):T {
                return this._set[key];
            }

            /**
             * forEach invokes the supplied function for each member of the set.
             */
            forEach(fn:(T)=>void) {
                for (var k in this._set) {
                    fn(this._set[k]);
                }
            }
        }

        /**
         * QueryResultSet is a set structure that contains at most one
         * QueryResult object for each possible key. The key for each
         * QueryResult is generated by the QueryInfoKey() method.
         */
        export type QueryResultSet = QueryInfoSet<Proto.QueryResult>;

        /**
         * QueryRequestSet is a set structure that contains at most one
         * QueryRequest object for each possible key. The key for each
         * QueryRequest is generated by the QueryInfoKey() method.
         */
        export type QueryRequestSet = QueryInfoSet<Proto.QueryRequest>;

        /**
         * select contains time series selectors for use in metrics queries.
         * Each selector defines a dataset on the server which should be
         * queried, along with additional information about how to process the
         * data (e.g. aggregation functions, transformations) and how it should
         * be displayed (e.g.  a friendly title for graph legends).
         */
        export module select {

            /**
             * Selector is the common interface implemented by all Selector
             * types. The is a read-only interface used by other components to
             * extract relevant information from the selector.
             */
            export interface Selector {
                /**
                 * request returns a QueryRequest object based on this selector.
                 */
                request():Proto.QueryRequest;
                /**
                 * series returns the series that is being queried.
                 */
                series():string;
                /**
                 * title returns a display-friendly title for this series.
                 */
                title():string;
            }

            /**
             * AvgSelector selects the average value of the supplied time series.
             */
            class AvgSelector implements Selector {
                constructor(private series_name:string) {}

                title = Utils.chainProp(this, this.series_name);

                series = () => { return this.series_name }

                request = ():Proto.QueryRequest => {
                    return {
                        name:this.series_name,
                        aggregator:Proto.QueryAggregator.AVG,
                    }
                }
            }

            /**
             * AvgRateSelector selects the rate of change of the average value
             * of the supplied time series.
             */
            class AvgRateSelector implements Selector {
                constructor(private series_name:string) {}

                title = Utils.chainProp(this, this.series_name);

                series = () => { return this.series_name }

                request = ():Proto.QueryRequest => {
                    return {
                        name:this.series_name,
                        aggregator:Proto.QueryAggregator.AVG_RATE,
                    }
                }
            }

            /**
             * Avg instantiates a new AvgSelector for the supplied time series.
             */
            export function Avg(series:string):AvgSelector {
                return new AvgSelector(series);
            }

            /**
             * AvgRate instantiates a new AvgRateSelector for the supplied time
             * series.
             */
            export function AvgRate(series:string):AvgRateSelector {
                return new AvgRateSelector(series);
            }
        }

        /**
         * time contains available time span specifiers for metrics queries.
         */
        export module time {
            /**
             * TimeSpan is the interface implemeted by time span specifiers.
             */
            export interface TimeSpan {
                /**
                 * timespan returns a two-value number array which defines the
                 * time range of a query. The first value is a timestamp for the
                 * start of the range, the second value a timestamp for the end
                 * of the range.
                 */
                timespan():number[];
            }

            /**
             * Recent selects a duration of constant size extending backwards
             * from the current time. The current time is recomputed each time
             * Recent's timespan() method is called.
             */
            export function Recent(duration:number):TimeSpan {
                return {
                    timespan: function():number[] {
                        var endTime = new Date();
                        var startTime = new Date(endTime.getTime() - duration);
                        return [startTime.getTime(), endTime.getTime()]
                    }
                }
            }
        }

        /**
         * An Axis is a collection of selectors which are expressed in the same
         * units. Data from the selectors can be displayed together on the same
         * chart with a shared domain.
         */
        export class Axis {
            /**
             * label is a string value which labels the axis. This should
             * describe the units for values on the axis.
             */
            label = Utils.chainProp(this, <string> null);

            /**
             * format is a function which formats numerical values on the axis
             * for display.
             */
            format = Utils.chainProp(this, <(n:number) => string> null);

            /**
             * selectors is an array of selectors which should be displayed on this
             * axis.
             */
            selectors = Utils.chainProp(this, <select.Selector[]> []);

            /**
             * Title returns an appropriate title for a chart displaying this
             * axis. This is generated by combining the titles of all selectors
             * on the axis.
             */
            title():string { 
                var selectors = this.selectors();
                if (selectors.length == 0) {
                    return "No series selected.";
                }
                return selectors.map((s) => s.title()).join(" vs. ");
            }
        }

        /**
         * NewAxis constructs a new axis object which displays information from
         * the supplied selectors. Additional properties of the query can be
         * configured by calling setter methods on the returned Axis.
         */
        export function NewAxis(...selectors:select.Selector[]):Axis {
            return new Axis().selectors(selectors);
        }


        /**
         * Query describes a single, repeatable query for time series data. Each
         * query contains one or more time series selectors, and a time span
         * over which to query those selectors.
         */
        export class Query {
            /**
             * timespan gets or sets the TimeSpan over which data should be
             * queried. By default, the query will return the last ten minutes
             * of data.
             */
            timespan = Utils.chainProp(this, time.Recent(10 * 60 * 1000));

            /**
             * title gets or sets the title of this query, which can be applied
             * to visualizations of the data from this query.
             */
            title = Utils.chainProp(this, "Query Title");

            /**
             * selectors is a set of selectors which should be displayed on this
             * axis.
             */
            selectors = Utils.chainProp(this, <select.Selector[]> []);

            /**
             * execute dispatches a query to the server and returns a promise
             * for the results.
             */
            execute = ():promise<QueryResultSet> => {
                var s = this.timespan().timespan();
                var req:Proto.QueryRequestSet = {
                    start_nanos: Utils.Convert.MilliToNano(s[0]),
                    end_nanos: Utils.Convert.MilliToNano(s[1]),
                    queries:[],
                }
                
                // Build a set of requests by looping over selectors. The set of
                // requests will be de-duplicated.
                var requestSet = new QueryInfoSet<Proto.QueryRequest>();
                this.selectors().forEach((s:select.Selector) => {
                    requestSet.add(s.request());
                });
                requestSet.forEach((qr:Proto.QueryRequest) => {
                    req.queries.push(qr);
                });
                return Query.dispatch_query(req)
            }

            private static dispatch_query(q:Proto.QueryRequestSet):promise<QueryResultSet> {
                return Utils.Http.Post("/ts/query", q)
                    .then((d:Proto.QueryResultSet) => {
                        // Populate missing collection fields with empty arrays.
                        if (!d.results) {
                            d.results = [];
                        }
                        var result = new QueryInfoSet<Proto.QueryResult>();
                        d.results.forEach((r) => {
                            if (!r.datapoints) {
                                r.datapoints = []
                            }
                            result.add(r);
                        });
                        return result;
                    });
            }
        }

        /**
         * NewQuery constructs a new query object which queries the supplied
         * selectors. Additional properties of the query can be configured by
         * calling setter methods on the returned Query.
         */
        export function NewQuery(...selectors:select.Selector[]):Query {
            return new Query().selectors(selectors);
        }

        /**
         * Executor is a convenience class for persisting the results of a query
         * execution.
         */
        export class Executor extends Utils.QueryCache<QueryResultSet> {
            private _metricquery:Query;
            constructor(q:Query){
                super(q.execute);
                this._metricquery = q;
            }

            query = () => {
                return this._metricquery;
            }
        }
    }
}