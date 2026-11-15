// The grip under the tabs: press, drag up or down, release. It posts the height the tabs
// should take, counted from the height it was drawn for, so a post seen twice moves nothing.

import type { ClientModule } from 'claude-code'

type Props = { rows: number }
type State = { isDragging: boolean }

const Handle: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const isDragging = surface.state?.isDragging === true

  // Set again on each draw so the listener reads the height it was drawn for.
  surface.onPointer(event => {
    if (event.type === 'down' && event.button === 'left') {
      surface.setState({ isDragging: true })
    } else if (event.type === 'move' && isDragging && event.y !== 0) {
      surface.post({ rows: props.rows + event.y })
    } else if (event.type === 'up' && isDragging) {
      surface.setState({ isDragging: false })
      surface.post({ rows: props.rows + event.y, isDone: true })
    }
  })

  const side = Math.max(0, Math.floor((surface.columns - 3) / 2))
  return (
    <Box height={1} overflow="hidden">
      <Text color={isDragging ? 'claude' : undefined} dimColor={!isDragging}>
        {'─'.repeat(side)} ⇕ {'─'.repeat(side)}
      </Text>
    </Box>
  )
}

export default Handle
