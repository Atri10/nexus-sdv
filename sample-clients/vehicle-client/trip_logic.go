package main

import (
	"math"
	"sort"
)

// simTrip is the shared route walked by every simulated drive state.
var simTrip = newTrip()

// tripPoint is one waypoint of the simulated trip route.
type tripPoint struct {
	lat float64
	lng float64
}

// trip is a closed driving route the simulator walks. Position advances
// along the route by distance = velocity * dt, so the GPS trace follows a
// real street geometry instead of a random walk.
type trip struct {
	pts     []tripPoint
	cumDist []float64 // cumulative distance (m) at the start of each point
	total   float64   // total loop length (m)
}

// newTrip precomputes cumulative distances for the embedded route.
func newTrip() *trip {
	t := &trip{pts: tripRoute}
	t.cumDist = make([]float64, len(t.pts))
	for i := 1; i < len(t.pts); i++ {
		t.cumDist[i] = t.cumDist[i-1] + distanceM(t.pts[i-1], t.pts[i])
	}
	t.total = t.cumDist[len(t.pts)-1]
	return t
}

// distanceM returns the great-circle distance in metres (Haversine).
func distanceM(a, b tripPoint) float64 {
	const earthRadius = 6371000.0
	dLat := (b.lat - a.lat) * math.Pi / 180
	dLng := (b.lng - a.lng) * math.Pi / 180
	h := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(a.lat*math.Pi/180)*math.Cos(b.lat*math.Pi/180)*math.Sin(dLng/2)*math.Sin(dLng/2)
	return 2 * earthRadius * math.Asin(math.Sqrt(h))
}

// positionAt returns the position and heading (degrees clockwise from
// north) at distance d metres along the loop; d wraps around the route.
func (t *trip) positionAt(d float64) (lat, lng, headingDeg float64) {
	if len(t.pts) == 0 {
		return 0, 0, 0
	}
	if t.total <= 0 {
		return t.pts[0].lat, t.pts[0].lng, 0
	}
	dd := math.Mod(d, t.total)
	if dd < 0 {
		dd += t.total
	}
	// Find the segment containing dd (first point with cumDist > dd).
	i := sort.SearchFloat64s(t.cumDist, dd)
	if i == 0 {
		i = 1
	}
	if i >= len(t.pts) {
		i = len(t.pts) - 1
	}
	a, b := t.pts[i-1], t.pts[i]
	segLen := t.cumDist[i] - t.cumDist[i-1]
	f := 0.0
	if segLen > 0 {
		f = (dd - t.cumDist[i-1]) / segLen
	}
	lat = a.lat + (b.lat-a.lat)*f
	lng = a.lng + (b.lng-a.lng)*f

	// Heading: direction of the segment (equirectangular approximation).
	// The route's first point closes the loop, so segment i=1.. is always valid.
	dLat := (b.lat - a.lat) * math.Pi / 180
	dLng := (b.lng - a.lng) * math.Pi / 180
	midLat := (a.lat + b.lat) / 2 * math.Pi / 180
	headingDeg = math.Mod(math.Atan2(dLng*math.Cos(midLat), dLat)*180/math.Pi+360, 360)
	return lat, lng, headingDeg
}
