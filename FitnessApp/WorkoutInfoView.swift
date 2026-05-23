import SwiftUI

struct WorkoutInfoButton: View {
    var prescription: SetPrescription
    var block: WorkoutBlock?
    @State private var isPresented = false

    var body: some View {
        Button {
            isPresented = true
        } label: {
            Image(systemName: "info.circle")
                .font(.body)
                .foregroundStyle(AppTheme.accent)
                .accessibilityLabel("\(prescription.exercise.title) explanation")
        }
        .buttonStyle(.plain)
        .help("What this workout means")
        .popover(isPresented: $isPresented, arrowEdge: .top) {
            WorkoutInfoContent(prescription: prescription, block: block)
                .presentationCompactAdaptation(.sheet)
                .presentationDetents([.medium, .large])
        }
    }
}

struct WorkoutInfoContent: View {
    var prescription: SetPrescription
    var block: WorkoutBlock?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text(prescription.exercise.title)
                    .font(.headline)
                Text(workoutInstruction(prescription))
                    .font(.subheadline)
                Text(exerciseCue(prescription.exercise))
                    .font(.caption)
                    .foregroundStyle(AppTheme.muted)

                VStack(alignment: .leading, spacing: 8) {
                    InfoLine(title: "Target", value: workoutTargetText(prescription))
                    InfoLine(title: "Rest", value: durationText(seconds: prescription.restSeconds))
                    InfoLine(title: "Effort", value: prescription.intensity)
                    if let block {
                        InfoLine(title: "Block", value: block.name)
                    }
                }
                .padding(10)
                .background(AppTheme.surfaceRaised)
                .clipShape(RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous))

                if let block {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Workout context")
                            .font(.subheadline.bold())
                        Text(block.detail)
                            .font(.caption)
                            .foregroundStyle(AppTheme.muted)
                    }
                    .padding(10)
                    .background(AppTheme.surfaceRaised)
                    .clipShape(RoundedRectangle(cornerRadius: AppTheme.smallRadius, style: .continuous))
                }

                Text(workoutLoggingNote(prescription.exercise))
                    .font(.caption)
                    .foregroundStyle(AppTheme.muted)
            }
            .padding(16)
            .frame(maxWidth: 340, alignment: .leading)
        }
        .background(AppTheme.background)
    }
}
