package kv

import (
	"bytes"
	"reflect"
	"testing"

	"github.com/cockroachdb/cockroach/keys"
	"github.com/cockroachdb/cockroach/roachpb"
	"github.com/cockroachdb/cockroach/testutils"
	"github.com/cockroachdb/cockroach/util/leaktest"
	"github.com/gogo/protobuf/proto"
)

func TestTruncate(t *testing.T) {
	defer leaktest.AfterTest(t)
	loc := func(s string) string {
		return string(keys.RangeDescriptorKey(roachpb.RKey(s)))
	}
	testCases := []struct {
		keys     [][2]string
		expKeys  [][2]string
		from, to string
		desc     [2]string // optional, defaults to {from,to}
		err      string
	}{
		{
			// Keys inside of active range.
			keys:    [][2]string{{"a", "q"}, {"c"}, {"b, e"}, {"q"}},
			expKeys: [][2]string{{"a", "q"}, {"c"}, {"b, e"}, {"q"}},
			from:    "a", to: "q\x00",
		},
		{
			// Keys outside of active range.
			keys:    [][2]string{{"a"}, {"a", "b"}, {"q"}, {"q", "z"}},
			expKeys: [][2]string{{}, {}, {}, {}},
			from:    "b", to: "q",
		},
		{
			// Range-local keys inside of active range.
			keys:    [][2]string{{loc("b")}, {loc("c")}},
			expKeys: [][2]string{{loc("b")}, {loc("c")}},
			from:    "b", to: "e",
		},
		{
			// Range-local key outside of active range.
			keys:    [][2]string{{loc("a")}},
			expKeys: [][2]string{{}},
			from:    "b", to: "e",
		},
		{
			// Range-local range contained in active range.
			keys:    [][2]string{{loc("b"), loc("e") + "\x00"}},
			expKeys: [][2]string{{loc("b"), loc("e") + "\x00"}},
			from:    "b", to: "e\x00",
		},

		{
			// Range-local range not contained in active range.
			keys: [][2]string{{loc("a"), loc("b")}},
			from: "b", to: "e",
			err: "local key range must not span ranges",
		},
		{
			// Mixed range-local vs global key range.
			keys: [][2]string{{loc("c"), "d\x00"}},
			from: "b", to: "e",
			err: "local key mixed with global key",
		},
		{
			// Key range touching and intersecting active range.
			keys:    [][2]string{{"a", "b"}, {"a", "c"}, {"p", "q"}, {"p", "r"}, {"a", "z"}},
			expKeys: [][2]string{{}, {"b", "c"}, {"p", "q"}, {"p", "q"}, {"b", "q"}},
			from:    "b", to: "q",
		},
		// Active key range is intersection of descriptor and [from,to).
		{
			keys:    [][2]string{{"c", "q"}},
			expKeys: [][2]string{{"d", "p"}},
			from:    "a", to: "z",
			desc: [2]string{"d", "p"},
		},
		{
			keys:    [][2]string{{"c", "q"}},
			expKeys: [][2]string{{"d", "p"}},
			from:    "d", to: "p",
			desc: [2]string{"a", "z"},
		},
	}

	for i, test := range testCases {
		ba := &roachpb.BatchRequest{}
		for _, ks := range test.keys {
			if len(ks[1]) > 0 {
				ba.Add(&roachpb.ScanRequest{
					Span: roachpb.Span{Key: roachpb.Key(ks[0]), EndKey: roachpb.Key(ks[1])},
				})
			} else {
				ba.Add(&roachpb.GetRequest{
					Span: roachpb.Span{Key: roachpb.Key(ks[0])},
				})
			}
		}
		original := proto.Clone(ba).(*roachpb.BatchRequest)

		desc := &roachpb.RangeDescriptor{
			StartKey: roachpb.RKey(test.desc[0]), EndKey: roachpb.RKey(test.desc[1]),
		}
		if len(desc.StartKey) == 0 {
			desc.StartKey = roachpb.RKey(test.from)
		}
		if len(desc.EndKey) == 0 {
			desc.EndKey = roachpb.RKey(test.to)
		}
		undo, num, err := truncate(ba, desc, roachpb.RKey(test.from), roachpb.RKey(test.to))
		if err != nil || test.err != "" {
			if test.err == "" || !testutils.IsError(err, test.err) {
				t.Errorf("%d: %v (expected: %s)", i, err, test.err)
			}
			continue
		}
		var reqs int
		for j, arg := range ba.Requests {
			req := arg.GetInner()
			if h := req.Header(); !bytes.Equal(h.Key, roachpb.Key(test.expKeys[j][0])) || !bytes.Equal(h.EndKey, roachpb.Key(test.expKeys[j][1])) {
				t.Errorf("%d.%d: range mismatch: actual [%q,%q), wanted [%q,%q)", i, j,
					h.Key, h.EndKey, test.expKeys[j][0], test.expKeys[j][1])
			} else if _, ok := req.(*roachpb.NoopRequest); ok != (len(h.Key) == 0) {
				t.Errorf("%d.%d: expected NoopRequest, got %T", i, j, req)
			} else if len(h.Key) != 0 {
				reqs++
			}
		}
		if reqs != num {
			t.Errorf("%d: counted %d requests, but truncation indicated %d", i, reqs, num)
		}
		undo()
		if !reflect.DeepEqual(ba, original) {
			t.Errorf("%d: undoing truncation failed:\nexpected: %s\nactual: %s",
				i, original, ba)
		}
	}
}
