import React, { Component } from 'react';
import * as PropTypes from 'prop-types';
import { compose } from 'ramda';
import { createFragmentContainer } from 'react-relay';
import graphql from 'babel-plugin-relay/macro';
import { withStyles } from '@material-ui/core/styles';
import Paper from '@material-ui/core/Paper';
import inject18n from '../../../../components/i18n';
import CityPopover from './CityPopover';
import Reports from '../../analysis/Reports';
import StixDomainObjectHeader from '../../common/stix_domain_objects/StixDomainObjectHeader';

const styles = (theme) => ({
  container: {
    transition: theme.transitions.create('padding', {
      easing: theme.transitions.easing.sharp,
      duration: theme.transitions.duration.leavingScreen,
    }),
  },
  containerWithPadding: {
    flexGrow: 1,
    transition: theme.transitions.create('padding', {
      easing: theme.transitions.easing.easeOut,
      duration: theme.transitions.duration.enteringScreen,
    }),
    paddingRight: 310,
  },
  paper: {
    height: '100%',
    minHeight: '100%',
    margin: '5px 0 0 0',
    padding: '25px 15px 15px 15px',
    borderRadius: 6,
  },
});

class CityReportsComponent extends Component {
  constructor(props) {
    super(props);
    this.state = { withPadding: false };
  }

  render() {
    const { withPadding } = this.state;
    const { classes, city } = this.props;
    return (
      <div
        className={
          withPadding ? classes.containerWithPadding : classes.container
        }
      >
        <StixDomainObjectHeader
          stixDomainObject={city}
          PopoverComponent={<CityPopover />}
        />
        <Paper classes={{ root: classes.paper }} elevation={2}>
          <Reports
            objectId={city.id}
            onChangeOpenExports={(openExports) => this.setState({ withPadding: openExports })
            }
          />
        </Paper>
      </div>
    );
  }
}

CityReportsComponent.propTypes = {
  city: PropTypes.object,
  classes: PropTypes.object,
  t: PropTypes.func,
};

const CityReports = createFragmentContainer(CityReportsComponent, {
  city: graphql`
    fragment CityReports_city on City {
      id
      name
      x_opencti_aliases
    }
  `,
});

export default compose(inject18n, withStyles(styles))(CityReports);