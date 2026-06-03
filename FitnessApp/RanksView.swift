import SwiftData
import SwiftUI

struct ConsistencyStatusView: View {
    @Query private var ranks: [RankState]

    private var rank: RankState {
        ranks.first ?? RankState()
    }

    var body: some View {
        ConsistencyView(rank: rank, sessions: [], logs: [])
    }
}
